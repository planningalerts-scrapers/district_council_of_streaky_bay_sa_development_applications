// Parses the development applications at the South Australian District Council of Streaky Bay web
// site and places them in a database.
//
// Michael Bone
// 15th March 2019

"use strict";

import * as fs from "fs";
import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as urlparser from "url";
import * as moment from "moment";
import * as pdfjs from "pdfjs-dist";
import didYouMean, * as didyoumean from "didyoumean2";

sqlite3.verbose();

const DevelopmentApplicationsUrl = "https://www.streakybay.sa.gov.au/page.aspx?u=513";
const CommentUrl = "mailto:dcstreaky@streakybay.sa.gov.au";

declare const process: any;

// All valid street names, street suffixes, suburb names and hundred names.

let StreetNames = null;
let StreetSuffixes = null;
let SuburbNames = null;
let HundredNames = null;

// Sets up an sqlite database.

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text)");
            resolve(database);
        });
    });
}

// Inserts a row in the database if the row does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// A bounding rectangle.

interface Rectangle {
    x: number,
    y: number,
    width: number,
    height: number
}

// An element (consisting of text and a bounding rectangle) in a PDF document.

interface Element extends Rectangle {
    text: string
}

// Constructs a rectangle based on the intersection of the two specified rectangles.

function intersect(rectangle1: Rectangle, rectangle2: Rectangle): Rectangle {
    let x1 = Math.max(rectangle1.x, rectangle2.x);
    let y1 = Math.max(rectangle1.y, rectangle2.y);
    let x2 = Math.min(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y2 = Math.min(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    if (x2 >= x1 && y2 >= y1)
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    else
        return { x: 0, y: 0, width: 0, height: 0 };
}

// Calculates the fraction of an element that lies within a rectangle (as a percentage).  For
// example, if a quarter of the specifed element lies within the specified rectangle then this
// would return 25.

function getPercentageOfElementInRectangle(element: Element, rectangle: Rectangle) {
    let elementArea = getArea(element);
    let intersectionArea = getArea(intersect(rectangle, element));
    return (elementArea === 0) ? 0 : ((intersectionArea * 100) / elementArea);
}

// Calculates the area of a rectangle.

function getArea(rectangle: Rectangle) {
    return rectangle.width * rectangle.height;
}

// Constructs the full address string based on the specified address components.

function formatAddress(houseNumber: string, streetName: string, suburbName: string) {
    suburbName = suburbName.replace(/^HD /, "").replace(/ HD$/, "").replace(/ SA$/, "").trim();
    suburbName = SuburbNames[suburbName] || suburbName;
    let separator = ((houseNumber !== "" || streetName !== "") && suburbName !== "") ? ", " : "";
    return `${houseNumber} ${streetName}${separator}${suburbName}`.trim().replace(/\s\s+/g, " ").toUpperCase();
}

// Parses the address from the house number, street name and suburb name.  Note that these
// address components may actually contain multiple addresses (delimited by "ü" characters).

function parseAddress(houseNumber: string, streetName: string, suburbName: string) {
    // Two or more addresses are sometimes recorded in the same field.  This is done in a way
    // which is ambiguous (ie. it is not possible to reconstruct the original addresses perfectly).
    //
    // For example, the following address:
    //
    //     House Number: ü35
    //           Street: RAILWAYüSCHOOL TCE SOUTHüTERRA
    //           Suburb: PASKEVILLEüPASKEVILLE
    //
    // should be interpreted as the following two addresses:
    //
    //     RAILWAY TCE SOUTH, PASKEVILLE
    //     35 SCHOOL TERRA(CE), PASKEVILLE
    //
    // whereas the following address:
    //
    //     House Number: 79ü4
    //           Street: ROSSLYNüSWIFT WINGS ROADüROAD
    //           Suburb: WALLAROOüWALLAROO
    //
    // should be interpreted as the following two addresses:
    //
    //     79 ROSSLYN ROAD, WALLAROO
    //     4 SWIFT WINGS ROAD, WALLAROO
    //
    // And so notice that in the first case above the "TCE" text of the Street belonged to the
    // first address.  Whereas in the second case above the "WINGS" text of the Street belonged
    // to the second address (this was deduced by examining actual existing street names).

    if (!houseNumber.includes("ü"))
        return formatAddress(houseNumber, streetName, suburbName);

    // Split the house number on the "ü" character.

    let houseNumberTokens = houseNumber.split("ü");

    // Split the suburb name on the "ü" character.

    let suburbNameTokens = suburbName.split("ü");

    // The street name will have twice as many "ü" characters as the house number.  Each street
    // name is broken in two and the resulting strings are joined into two groups (delimited
    // by "ü" within the groups).  A single space is used to join the two groups together.
    //
    // For example, the street names "WALLACE STREET" and "MAY TERRACE" are broken in two as
    // "WALLACE" and "STREET"; and "MAY" and "TERRACE".  And then joined back together into
    // two groups, "WALLACEüMAY" and "STREETüTERRACE".  Those two groups are then concatenated
    // together using a single intervening space to form "WALLACEüMAY STREETüTERRACE".
    //
    // Unfortunately, the street name is truncated at 30 characters so some of the "ü" characters
    // may be missing.  Also note that there is an ambiguity in some cases as to whether a space
    // is a delimiter or is just a space that happens to occur within a street name or suffix 
    // (such as "Kybunga Top" in "Kybunga Top Road" or "TERRACE SOUTH" in "RAILWAY TERRACE SOUTH").
    //
    // For example,
    //
    //     PHILLIPSüHARBISON ROADüROAD     <-- street names broken in two and joined into groups
    //     BarrüFrances StreetüTerrace     <-- street names broken in two and joined into groups
    //     GOYDERüGOYDERüMail HDüHDüRoad   <-- street names broken in two and joined into groups
    //     ORIENTALüWINDJAMMER COURTüCOUR  <-- truncated street suffix
    //     TAYLORüTAYLORüTAYLOR STREETüST  <-- missing "ü" character due to truncation
    //     EDGARüEASTüEAST STREETüTERRACE  <-- missing "ü" character due to truncation
    //     SOUTH WESTüSOUTH WEST TERRACEü  <-- missing "ü" character due to truncation
    //     ChristopherüChristopher Street  <-- missing "ü" character due to truncation
    //     PORT WAKEFIELDüPORT WAKEFIELD   <-- missing "ü" character due to truncation
    //     KENNETT STREETüKENNETT STREET   <-- missing "ü" character due to truncation (the missing text is probably " SOUTHüSOUTH")
    //     NORTH WESTüNORTH WESTüNORTH WE  <-- missing "ü" characters due to truncation
    //     RAILWAYüSCHOOL TCE SOUTHüTERRA  <-- ambiguous space delimiter
    //     BLYTHüWHITE WELL HDüROAD        <-- ambiguous space delimiter
    //     Kybunga TopüKybunga Top RoadüR  <-- ambiguous space delimiter
    //     SOUTHüSOUTH TERRACE EASTüTERRA  <-- ambiguous space delimiter

    // Artificially increase the street name tokens to twice the length (minus one) of the house
    // number tokens (this then simplifies the following processing).  The "minus one" is because
    // the middle token will be split in two later.

    let streetNameTokens = streetName.split("ü");
    while (streetNameTokens.length < 2 * houseNumberTokens.length - 1)
        streetNameTokens.push("");

    // Consider the following street name (however, realistically this would be truncated at
    // 30 characters; this is ignored for the sake of explaining the parsing),
    //
    //     Kybunga TopüSmithüRailway South RoadüTerrace EastüTerrace
    //
    // This street name would be split into the following tokens,
    //
    //     Token 0: Kybunga Top
    //     Token 1: Smith
    //     Token 2: Railway South Road  <-- the middle token contains a delimiting space (it is ambiguous as to which space is the correct delimiter)
    //     Token 3: Terrace East
    //     Token 4: Terrace
    //
    // And from these tokens, the following candidate sets of tokens would be constructed (each
    // broken into two groups).  Note that the middle token [Railway South Road] is broken into
    // two tokens in different ways depending on which space is chosen as the delimiter for the
    // groups: [Railway] and [South Road] or [Railway South] and [Road].
    //
    //     Candidate 1: [Kybunga Top] [Smith] [Railway]   [South Road] [Terrace East] [Terrace]
    //                 └───────────╴Group 1╶───────────┘ └──────────────╴Group 2╶──────────────┘
    //
    //     Candidate 2: [Kybunga Top] [Smith] [Railway South]   [Road] [Terrace East] [Terrace]
    //                 └──────────────╴Group 1╶──────────────┘ └───────────╴Group 2╶───────────┘

    let candidates = [];

    let middleTokenIndex = houseNumberTokens.length - 1;
    if (!streetNameTokens[middleTokenIndex].includes(" "))  // the space may be missing if the street name is truncated at 30 characters
        streetNameTokens[middleTokenIndex] += " ";  // artificially add a space to simplify the processing

    let ambiguousTokens = streetNameTokens[middleTokenIndex].split(" ");
    for (let index = 1; index < ambiguousTokens.length; index++) {
        let group1 = [ ...streetNameTokens.slice(0, middleTokenIndex), ambiguousTokens.slice(0, index).join(" ")];
        let group2 = [ ambiguousTokens.slice(index).join(" "), ...streetNameTokens.slice(middleTokenIndex + 1)];
        candidates.push({ group1: group1, group2: group2, hasInvalidHundredName: false });
    }

    // Full street names (with suffixes) can now be constructed for each candidate (by joining
    // together corresponding tokens from each group of tokens).

    let addresses = [];
    for (let candidate of candidates) {
        for (let index = 0; index < houseNumberTokens.length; index++) {
            // Expand street suffixes such as "Tce" to "TERRACE".

            let streetSuffix = candidate.group2[index].split(" ")
                .map(token => (StreetSuffixes[token.toUpperCase()] === undefined) ? token : StreetSuffixes[token.toUpperCase()])
                .join(" ");

            // Construct the full street name (including the street suffix).

            let houseNumber = houseNumberTokens[index];
            let streetName = (candidate.group1[index] + " " + streetSuffix).trim().replace(/\s\s+/g, " ");
            if (streetName === "")
                continue;  // ignore blank street names

            // Check whether the street name is actually a hundred name such as "BARUNGA HD".

            if (streetName.endsWith(" HD")) { // very likely a hundred name
                let hundredNameMatch = didYouMean(streetName.slice(0, -3), HundredNames, { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 0, trimSpaces: true });
                if (hundredNameMatch === null)
                    candidate.hasInvalidHundredName = true;  // remember that there is an invalid hundred name (for example, "BARUNGA View HD")
                continue;  // ignore all hundred names names
            }

            // Determine the associated suburb name.

            let associatedSuburbName = suburbNameTokens[index];
            if (associatedSuburbName === undefined)
                associatedSuburbName = "";

            // Choose the best matching street name (from the known street names).

            let streetNameMatch = didYouMean(streetName, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 0, trimSpaces: true });
            if (streetNameMatch !== null)
                addresses.push({ houseNumber: houseNumber, streetName: streetName, suburbName: associatedSuburbName, threshold: 0, candidate: candidate });
            else {
                streetNameMatch = didYouMean(streetName, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 1, trimSpaces: true });
                if (streetNameMatch !== null)
                    addresses.push({ houseNumber: houseNumber, streetName: streetNameMatch, suburbName: associatedSuburbName, threshold: 1, candidate: candidate });
                else {
                    streetNameMatch = didYouMean(streetName, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true });
                    if (streetNameMatch !== null)
                        addresses.push({ houseNumber: houseNumber, streetName: streetNameMatch, suburbName: associatedSuburbName, threshold: 2, candidate: candidate });
                    else
                        addresses.push({ houseNumber: houseNumber, streetName: streetName, suburbName: associatedSuburbName, threshold: Number.MAX_VALUE, candidate: candidate });  // unrecognised street name
                }
            }
        }
    }

    if (addresses.length === 0)
        return undefined;  // no valid addresses found

    // Sort the addresses so that "better" addresses are moved to the front of the array.

    addresses.sort(addressComparer);

    // Format and return the "best" address.

    let address = addresses[0];
    return formatAddress(address.houseNumber, address.streetName, address.suburbName);
}
    
// Returns a number indicating which address is "larger" (in this case "larger" means a "worse"
// address).  This can be used to sort addresses so that "better" addresses, ie. those with a
// house number and fewer spelling errors appear at the start of an array.

function addressComparer(a, b) {
    // As long as there are one or two spelling errors then prefer the address with a
    // house number (even if it has more spelling errors).

    if (a.threshold <= 2 && b.threshold <= 2) {
        if (a.houseNumber === "" && b.houseNumber !== "")
            return 1;
        else if (a.houseNumber !== "" && b.houseNumber === "")
            return -1;
    }

    // For larger numbers of spelling errors prefer addresses with fewer spelling errors before
    // considering the presence of a house number.

    if (a.threshold > b.threshold)
        return 1;
    else if (a.threshold < b.threshold)
        return -1;

    if (a.houseNumber === "" && b.houseNumber !== "")
        return 1;
    else if (a.houseNumber !== "" && b.houseNumber === "")
        return -1;

    // All other things being equal (as tested above), avoid addresses belonging to a candidate
    // that has an invalid hundred name.  This is because having an invalid hundred name often
    // means that the wrong delimiting space has been chosen for that candidate (as below where
    // candidate 0 contains the invalid hundred name, "BARUNGA View HD", and so likely the other
    // address in that candidate is also wrong, namely, "Lake Road").
    //
    // Where there are multiple candidates mark down the candidates that contain street names
    // ending in " HD" and so likely represent a hundred name, but do not actually contain a
    // valid hundred name.  For example, the valid street name "Lake View Road" in candidate 1
    // is the better choice in the following because the hundred name "BARUNGA View HD" in
    // candidate 0 is invalid.
    //
    //     BARUNGAüLake View HDüRoad
    //
    // Candidate 0: [BARUNGA] [Lake]   [View HD] [Road]
    //             └───╴Group 1╶────┘ └───╴Group 2╶────┘
    //     Resulting street names:
    //         BARUNGA View HD  <-- invalid hundred name
    //         Lake Road        <-- valid street name
    //
    // Candidate 1: [BARUNGA] [Lake View]   [HD] [Road]
    //             └──────╴Group 1╶──────┘ └─╴Group 2╶─┘
    //     Resulting street names:
    //         BARUNGA HD      <-- valid hundred name 
    //         Lake View Road  <-- valid street name

    if (a.candidate.hasInvalidHundredName && !b.candidate.hasInvalidHundredName)
        return 1;
    else if (!a.candidate.hasInvalidHundredName && b.candidate.hasInvalidHundredName)
        return -1;
}

// Parses the details from the elements associated with a single page of the PDF (corresponding
// to a single development application).

function parseOldFormatApplicationElements(elements: Element[], informationUrl: string) {
    // Get the application number (by finding all elements that are at least 10% within the
    // calculated bounding rectangle).

    let applicationHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "applicationnumber:");
    let applicationFeesHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "applicationfees:");
    let applicationDateHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "applicationdate:");
    let developmentCompletedHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "developmentcompleted:");
    let propertyAddressHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "propertyaddress:");
    let developmentDescriptionHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "developmentdescription:");
    let relevantAuthorityHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "relevantauthority:");

    // Get the development application number.

    if (applicationHeadingElement === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Ignoring the page because the "Application Number" heading is missing.  Elements: ${elementSummary}`);
        return undefined;
    }

    let applicationNumber = "";
    let applicationNumberBounds = {
        x: applicationHeadingElement.x + applicationHeadingElement.width,
        y: applicationHeadingElement.y,
        width: (applicationFeesHeadingElement === undefined) ? (applicationHeadingElement.width * 3) : (applicationFeesHeadingElement.x - applicationHeadingElement.x - applicationHeadingElement.width),
        height: applicationHeadingElement.height
    };
    let applicationNumberElement = elements.find(element => getPercentageOfElementInRectangle(element, applicationNumberBounds) > 10);
    applicationNumber = (applicationNumberElement === undefined) ? "" : applicationNumberElement.text.replace(/\s/g, "");

    if (applicationNumber === "") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Ignoring the page because the development application number text is missing.  Elements: ${elementSummary}`);
        return undefined;
    }

    console.log(`    Found \"${applicationNumber}\".`);

    // Get the received date.

    let receivedDate = moment.invalid();
    if (applicationDateHeadingElement !== undefined) {
        let receivedDateBounds = {
            x: applicationDateHeadingElement.x + applicationDateHeadingElement.width,
            y: applicationDateHeadingElement.y,
            width: (developmentCompletedHeadingElement === undefined) ? (applicationDateHeadingElement.width * 3) : (developmentCompletedHeadingElement.x - applicationDateHeadingElement.x - applicationDateHeadingElement.width),
            height: applicationDateHeadingElement.height
        };
        let receivedDateElement = elements.find(element => getPercentageOfElementInRectangle(element, receivedDateBounds) > 10);
        if (receivedDateElement !== undefined)
            receivedDate = moment(receivedDateElement.text.trim(), "D/M/YYYY", true);  // allows the leading zero of the day or month to be omitted
    }

    // Get the address.

    if (propertyAddressHeadingElement === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Ignoring the page because the "Property Address" heading is missing.  Elements: ${elementSummary}`);
        return undefined;
    }

    let addressBounds = {
        x: propertyAddressHeadingElement.x + propertyAddressHeadingElement.width,
        y: propertyAddressHeadingElement.y,
        width: (applicationFeesHeadingElement === undefined) ? (propertyAddressHeadingElement.width * 3) : (applicationFeesHeadingElement.x - propertyAddressHeadingElement.x - propertyAddressHeadingElement.width),
        height: propertyAddressHeadingElement.height
    };
    let address = elements.filter(element => getPercentageOfElementInRectangle(element, addressBounds) > 10).map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");

    if (address === "") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find an address for the current development application ${applicationNumber}.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }

    // Get the description.

    let description = "";
    if (developmentDescriptionHeadingElement !== undefined) {
        let descriptionBounds = {
            x: developmentDescriptionHeadingElement.x + developmentDescriptionHeadingElement.width,
            y: developmentDescriptionHeadingElement.y,
            width: (applicationFeesHeadingElement === undefined) ? (developmentDescriptionHeadingElement.width * 3) : (applicationFeesHeadingElement.x - developmentDescriptionHeadingElement.x - developmentDescriptionHeadingElement.width),
            height: (relevantAuthorityHeadingElement === undefined) ? Number.MAX_VALUE : (relevantAuthorityHeadingElement.y - developmentDescriptionHeadingElement.y)
        };
        description = elements.filter(element => getPercentageOfElementInRectangle(element, descriptionBounds) > 10).map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
    }

    return {
        applicationNumber: applicationNumber,
        address: address,
        description: (description === "") ? "No description provided" : description,
        informationUrl: informationUrl,
        commentUrl: CommentUrl,
        scrapeDate: moment().format("YYYY-MM-DD"),
        receivedDate: receivedDate.isValid() ? receivedDate.format("YYYY-MM-DD") : ""
    }
}

// Parses the details from the elements associated with a single page of the PDF (corresponding
// to a single development application).

function parseNewFormatApplicationElements(elements: Element[], informationUrl: string) {
    // Get the application number (by finding all elements that are at least 10% within the
    // calculated bounding rectangle).

    let applicationHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "").startsWith("development"));
    let applicationDateHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "applicationdate");
    let assessmentNumberHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "assessmentnumber");
    let developmentDescriptionHeadingElement = elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "developmentdescription");

    // Get the development application number.

    if (applicationHeadingElement === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Ignoring the page because the "Development" heading is missing.  Elements: ${elementSummary}`);
        return undefined;
    }

    let applicationNumber = "";
    let tokens = applicationHeadingElement.text.trim().replace(/\s\s+/g, " ").split(" ");
    if (tokens.length >= 2)
        applicationNumber = tokens[1];
    else {
        let applicationNumberBounds = {
            x: applicationHeadingElement.x + applicationHeadingElement.width,
            y: applicationHeadingElement.y,
            width: (applicationDateHeadingElement === undefined) ? (applicationHeadingElement.width * 3) : (applicationDateHeadingElement.x - applicationHeadingElement.x - applicationHeadingElement.width),
            height: applicationHeadingElement.height
        };
        let applicationNumberElement = elements.find(element => getPercentageOfElementInRectangle(element, applicationNumberBounds) > 10);
        applicationNumber = (applicationNumberElement === undefined) ? "" : applicationNumberElement.text.replace(/\s/g, "");
    }

    if (applicationNumber === "") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Ignoring the page because the development application number text is missing.  Elements: ${elementSummary}`);
        return undefined;
    }

    console.log(`    Found \"${applicationNumber}\".`);

    // Get the received date.

    let receivedDate = moment.invalid();
    if (applicationDateHeadingElement !== undefined) {
        let receivedDateBounds = {
            x: applicationDateHeadingElement.x + applicationDateHeadingElement.width,
            y: applicationDateHeadingElement.y,
            width: Number.MAX_VALUE,
            height: applicationDateHeadingElement.height
        };
        let receivedDateElement = elements.find(element => getPercentageOfElementInRectangle(element, receivedDateBounds) > 10);
        if (receivedDateElement !== undefined)
            receivedDate = moment(receivedDateElement.text.trim(), "D/M/YYYY", true);  // allows the leading zero of the day or month to be omitted
    }

    // Get the address.

    if (assessmentNumberHeadingElement === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Ignoring the page because the "Assessment Number" heading is missing.  Elements: ${elementSummary}`);
        return undefined;
    }

    let addressBounds = {
        x: assessmentNumberHeadingElement.x + assessmentNumberHeadingElement.width,
        y: assessmentNumberHeadingElement.y + assessmentNumberHeadingElement.height,
        width: Number.MAX_VALUE,
        height: (developmentDescriptionHeadingElement === undefined) ? 2 * assessmentNumberHeadingElement.height : (developmentDescriptionHeadingElement.y - (assessmentNumberHeadingElement.y + assessmentNumberHeadingElement.height))
    };
    let address = elements.filter(element => getPercentageOfElementInRectangle(element, addressBounds) > 10).map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");

    if (address === "") {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find an address for the current development application ${applicationNumber}.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }

    // Get the description.

    let description = "";
    if (developmentDescriptionHeadingElement !== undefined) {
        let descriptionBounds = {
            x: developmentDescriptionHeadingElement.x + developmentDescriptionHeadingElement.width,
            y: developmentDescriptionHeadingElement.y,
            width: Number.MAX_VALUE,
            height: developmentDescriptionHeadingElement.height
        };
        description = elements.filter(element => getPercentageOfElementInRectangle(element, descriptionBounds) > 10).map(element => element.text).join(" ").trim().replace(/\s\s+/g, " ");
    }

    return {
        applicationNumber: applicationNumber,
        address: address,
        description: (description === "") ? "No description provided" : description,
        informationUrl: informationUrl,
        commentUrl: CommentUrl,
        scrapeDate: moment().format("YYYY-MM-DD"),
        receivedDate: receivedDate.isValid() ? receivedDate.format("YYYY-MM-DD") : ""
    }
}

// Parses the development applications in the specified date range.

async function parsePdf(url: string) {
    console.log(`Reading development applications from ${url}.`);

    let developmentApplications = [];

    // Read the PDF.

    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);

    // Parse the PDF.  Each page has the details of multiple applications.  Note that the PDF is
    // re-parsed on each iteration of the loop (ie. once for each page).  This then avoids large
    // memory usage by the PDF (just calling page._destroy() on each iteration of the loop appears
    // not to be enough to release all memory used by the PDF parsing).

    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {  // limit to an arbitrarily large number of pages (to avoid any chance of an infinite loop)
        let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
        if (pageIndex >= pdf.numPages)
            break;

        console.log(`Reading and parsing applications from page ${pageIndex + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(pageIndex + 1);
        let textContent = await page.getTextContent();
        let viewport = await page.getViewport(1.0);
    
        let elements: Element[] = textContent.items.map(item => {
            let transform = pdfjs.Util.transform(viewport.transform, item.transform);
    
            // Work around the issue https://github.com/mozilla/pdf.js/issues/8276 (heights are
            // exaggerated).  The problem seems to be that the height value is too large in some
            // PDFs.  Provide an alternative, more accurate height value by using a calculation
            // based on the transform matrix.
    
            let workaroundHeight = Math.sqrt(transform[2] * transform[2] + transform[3] * transform[3]);
            return { text: item.str, x: transform[4], y: transform[5], width: item.width, height: workaroundHeight };
        });

        // Release the memory used by the PDF now that it is no longer required (it will be
        // re-parsed on the next iteration of the loop for the next page).

        await pdf.destroy();
        if (global.gc)
            global.gc();

        // Sort the elements by Y co-ordinate and then by X co-ordinate.

        let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
        elements.sort(elementComparer);

        let developmentApplication = undefined;

        if (elements.find(element => element.text.toLowerCase().replace(/\s/g, "") === "applicationfees:") === undefined)
            developmentApplication = parseNewFormatApplicationElements(elements, url);
        else
            developmentApplication = parseOldFormatApplicationElements(elements, url);

        if (developmentApplication !== undefined)
            if (!developmentApplications.some(otherDevelopmentApplication => otherDevelopmentApplication.applicationNumber === developmentApplication.applicationNumber))  // ignore duplicates
                developmentApplications.push(developmentApplication);
    }

    return developmentApplications;
}

// Gets a random integer in the specified range: [minimum, maximum).

function getRandom(minimum: number, maximum: number) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Pauses for the specified number of milliseconds.

function sleep(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Read the files containing all possible street names, street suffixes, suburb names and
    // hundred names.  Note that these are not currently used.

    StreetNames = {};
    for (let line of fs.readFileSync("streetnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetNameTokens = line.toUpperCase().split(",");
        let streetName = streetNameTokens[0].trim();
        let suburbName = streetNameTokens[1].trim();
        (StreetNames[streetName] || (StreetNames[streetName] = [])).push(suburbName);  // several suburbs may exist for the same street name
    }

    StreetSuffixes = {};
    for (let line of fs.readFileSync("streetsuffixes.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let streetSuffixTokens = line.toUpperCase().split(",");
        StreetSuffixes[streetSuffixTokens[0].trim()] = streetSuffixTokens[1].trim();
    }

    SuburbNames = {};
    for (let line of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n")) {
        let suburbTokens = line.toUpperCase().split(",");
        SuburbNames[suburbTokens[0].trim()] = suburbTokens[1].trim();
    }

    HundredNames = [];
    for (let line of fs.readFileSync("hundrednames.txt").toString().replace(/\r/g, "").trim().split("\n"))
        HundredNames.push(line.trim().toUpperCase());

    // Read the main page that has links to each year of development applications.

    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);

    let body = await request({ url: DevelopmentApplicationsUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);

    let yearPageUrls: string[] = [];
    for (let element of $("div.unityHtmlArticle p a").get()) {
        let yearPageUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href
        if ($(element).text().toLowerCase().includes("register"))
            if (!yearPageUrls.some(url => url === yearPageUrl))
                yearPageUrls.push(yearPageUrl);
    }

    if (yearPageUrls.length === 0) {
        console.log("No PDF files were found to examine.");
        return;
    }

    // Select the current year and randomly select one other year (this is purposely allowed to
    // even be the same year as the current year).

    let currentYearPageUrl = yearPageUrls[0];
    let randomYearPageUrl = yearPageUrls[getRandom(0, yearPageUrls.length)];

    let selectedPdfUrls: string[] = [];

    // Read the current year page and select the most recent PDF.

    console.log(`Retrieving current year page: ${currentYearPageUrl}`);

    body = await request({ url: currentYearPageUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    $ = cheerio.load(body);

    let currentYearPdfUrls: string[] = [];

    for (let element of $("div.unityHtmlArticle p a").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href
        if ($(element).text().toLowerCase().includes("register") && pdfUrl.toLowerCase().includes(".pdf"))
            if (!currentYearPdfUrls.some(url => url === pdfUrl))
                currentYearPdfUrls.push(pdfUrl);
    }

    if (currentYearPdfUrls.length > 0)
        selectedPdfUrls.push(currentYearPdfUrls.pop());

    // Read the random year page and randomly select a PDF from that page.
    
    console.log(`Retrieving random year page: ${randomYearPageUrl}`);

    body = await request({ url: randomYearPageUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    $ = cheerio.load(body);

    let randomYearPdfUrls: string[] = [];

    for (let element of $("div.unityHtmlArticle p a").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href
        if ($(element).text().toLowerCase().includes("register") && pdfUrl.toLowerCase().includes(".pdf"))
            if (!randomYearPdfUrls.some(url => url === pdfUrl))
                randomYearPdfUrls.push(pdfUrl);
    }

    if (randomYearPdfUrls.length > 0)
        selectedPdfUrls.push(randomYearPdfUrls[getRandom(0, randomYearPdfUrls.length)]);
    
    // Parse the selected PDFs (avoid processing all PDFs at once because this may use too much
    // memory, resulting in morph.io terminating the current process).

    if (selectedPdfUrls.length === 0) {
        console.log("No PDF files were selected to be examined.");
        return;
    }

    for (let pdfUrl of selectedPdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);

        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the
        // current process being terminated by morph.io).

        if (global.gc)
            global.gc();

        console.log(`Inserting development applications into the database.`);
        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
