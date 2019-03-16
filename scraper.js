// Parses the development applications at the South Australian District Council of Streaky Bay web
// site and places them in a database.
//
// Michael Bone
// 15th March 2019
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const cheerio = require("cheerio");
const request = require("request-promise-native");
const sqlite3 = require("sqlite3");
const urlparser = require("url");
const moment = require("moment");
const pdfjs = require("pdfjs-dist");
const didyoumean2_1 = require("didyoumean2"), didyoumean = didyoumean2_1;
sqlite3.verbose();
const DevelopmentApplicationsUrl = "https://www.streakybay.sa.gov.au/page.aspx?u=513";
const CommentUrl = "mailto:dcstreaky@streakybay.sa.gov.au";
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
        ], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// Constructs a rectangle based on the intersection of the two specified rectangles.
function intersect(rectangle1, rectangle2) {
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
function getPercentageOfElementInRectangle(element, rectangle) {
    let elementArea = getArea(element);
    let intersectionArea = getArea(intersect(rectangle, element));
    return (elementArea === 0) ? 0 : ((intersectionArea * 100) / elementArea);
}
// Calculates the area of a rectangle.
function getArea(rectangle) {
    return rectangle.width * rectangle.height;
}
// Constructs the full address string based on the specified address components.
function formatAddress(houseNumber, streetName, suburbName) {
    suburbName = suburbName.replace(/^HD /, "").replace(/ HD$/, "").replace(/ SA$/, "").trim();
    suburbName = SuburbNames[suburbName] || suburbName;
    let separator = ((houseNumber !== "" || streetName !== "") && suburbName !== "") ? ", " : "";
    return `${houseNumber} ${streetName}${separator}${suburbName}`.trim().replace(/\s\s+/g, " ").toUpperCase();
}
// Parses the address from the house number, street name and suburb name.  Note that these
// address components may actually contain multiple addresses (delimited by "ü" characters).
function parseAddress(houseNumber, streetName, suburbName) {
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
    if (!streetNameTokens[middleTokenIndex].includes(" ")) // the space may be missing if the street name is truncated at 30 characters
        streetNameTokens[middleTokenIndex] += " "; // artificially add a space to simplify the processing
    let ambiguousTokens = streetNameTokens[middleTokenIndex].split(" ");
    for (let index = 1; index < ambiguousTokens.length; index++) {
        let group1 = [...streetNameTokens.slice(0, middleTokenIndex), ambiguousTokens.slice(0, index).join(" ")];
        let group2 = [ambiguousTokens.slice(index).join(" "), ...streetNameTokens.slice(middleTokenIndex + 1)];
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
                continue; // ignore blank street names
            // Check whether the street name is actually a hundred name such as "BARUNGA HD".
            if (streetName.endsWith(" HD")) { // very likely a hundred name
                let hundredNameMatch = didyoumean2_1.default(streetName.slice(0, -3), HundredNames, { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 0, trimSpaces: true });
                if (hundredNameMatch === null)
                    candidate.hasInvalidHundredName = true; // remember that there is an invalid hundred name (for example, "BARUNGA View HD")
                continue; // ignore all hundred names names
            }
            // Determine the associated suburb name.
            let associatedSuburbName = suburbNameTokens[index];
            if (associatedSuburbName === undefined)
                associatedSuburbName = "";
            // Choose the best matching street name (from the known street names).
            let streetNameMatch = didyoumean2_1.default(streetName, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 0, trimSpaces: true });
            if (streetNameMatch !== null)
                addresses.push({ houseNumber: houseNumber, streetName: streetName, suburbName: associatedSuburbName, threshold: 0, candidate: candidate });
            else {
                streetNameMatch = didyoumean2_1.default(streetName, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 1, trimSpaces: true });
                if (streetNameMatch !== null)
                    addresses.push({ houseNumber: houseNumber, streetName: streetNameMatch, suburbName: associatedSuburbName, threshold: 1, candidate: candidate });
                else {
                    streetNameMatch = didyoumean2_1.default(streetName, Object.keys(StreetNames), { caseSensitive: false, returnType: didyoumean.ReturnTypeEnums.FIRST_CLOSEST_MATCH, thresholdType: didyoumean.ThresholdTypeEnums.EDIT_DISTANCE, threshold: 2, trimSpaces: true });
                    if (streetNameMatch !== null)
                        addresses.push({ houseNumber: houseNumber, streetName: streetNameMatch, suburbName: associatedSuburbName, threshold: 2, candidate: candidate });
                    else
                        addresses.push({ houseNumber: houseNumber, streetName: streetName, suburbName: associatedSuburbName, threshold: Number.MAX_VALUE, candidate: candidate }); // unrecognised street name
                }
            }
        }
    }
    if (addresses.length === 0)
        return undefined; // no valid addresses found
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
function parseOldFormatApplicationElements(elements, informationUrl) {
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
            receivedDate = moment(receivedDateElement.text.trim(), "D/M/YYYY", true); // allows the leading zero of the day or month to be omitted
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
    };
}
// Parses the details from the elements associated with a single page of the PDF (corresponding
// to a single development application).
function parseNewFormatApplicationElements(elements, informationUrl) {
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
            receivedDate = moment(receivedDateElement.text.trim(), "D/M/YYYY", true); // allows the leading zero of the day or month to be omitted
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
    };
}
// Parses the development applications in the specified date range.
async function parsePdf(url) {
    console.log(`Reading development applications from ${url}.`);
    let developmentApplications = [];
    // Read the PDF.
    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    // Parse the PDF.  Each page has the details of multiple applications.  Note that the PDF is
    // re-parsed on each iteration of the loop (ie. once for each page).  This then avoids large
    // memory usage by the PDF (just calling page._destroy() on each iteration of the loop appears
    // not to be enough to release all memory used by the PDF parsing).
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) { // limit to an arbitrarily large number of pages (to avoid any chance of an infinite loop)
        let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
        if (pageIndex >= pdf.numPages)
            break;
        console.log(`Reading and parsing applications from page ${pageIndex + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(pageIndex + 1);
        let textContent = await page.getTextContent();
        let viewport = await page.getViewport(1.0);
        let elements = textContent.items.map(item => {
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
            if (!developmentApplications.some(otherDevelopmentApplication => otherDevelopmentApplication.applicationNumber === developmentApplication.applicationNumber)) // ignore duplicates
                developmentApplications.push(developmentApplication);
    }
    return developmentApplications;
}
// Gets a random integer in the specified range: [minimum, maximum).
function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}
// Pauses for the specified number of milliseconds.
function sleep(milliseconds) {
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
        (StreetNames[streetName] || (StreetNames[streetName] = [])).push(suburbName); // several suburbs may exist for the same street name
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
    let yearPageUrls = [];
    for (let element of $("div.unityHtmlArticle p a").get()) {
        let yearPageUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
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
    let selectedPdfUrls = [];
    // Read the current year page and select the most recent PDF.
    console.log(`Retrieving current year page: ${currentYearPageUrl}`);
    body = await request({ url: currentYearPageUrl, rejectUnauthorized: false, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    $ = cheerio.load(body);
    let currentYearPdfUrls = [];
    for (let element of $("div.unityHtmlArticle p a").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
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
    let randomYearPdfUrls = [];
    for (let element of $("div.unityHtmlArticle p a").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsa0dBQWtHO0FBQ2xHLHNDQUFzQztBQUN0QyxFQUFFO0FBQ0YsZUFBZTtBQUNmLGtCQUFrQjtBQUVsQixZQUFZLENBQUM7O0FBRWIseUJBQXlCO0FBQ3pCLG1DQUFtQztBQUNuQyxrREFBa0Q7QUFDbEQsbUNBQW1DO0FBQ25DLGlDQUFpQztBQUNqQyxpQ0FBaUM7QUFDakMsb0NBQW9DO0FBQ3BDLHlFQUFzRDtBQUV0RCxPQUFPLENBQUMsT0FBTyxFQUFFLENBQUM7QUFFbEIsTUFBTSwwQkFBMEIsR0FBRyxrREFBa0QsQ0FBQztBQUN0RixNQUFNLFVBQVUsR0FBRyx1Q0FBdUMsQ0FBQztBQUkzRCwyRUFBMkU7QUFFM0UsSUFBSSxXQUFXLEdBQUcsSUFBSSxDQUFDO0FBQ3ZCLElBQUksY0FBYyxHQUFHLElBQUksQ0FBQztBQUMxQixJQUFJLFdBQVcsR0FBRyxJQUFJLENBQUM7QUFDdkIsSUFBSSxZQUFZLEdBQUcsSUFBSSxDQUFDO0FBRXhCLDhCQUE4QjtBQUU5QixLQUFLLFVBQVUsa0JBQWtCO0lBQzdCLE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7UUFDbkMsSUFBSSxRQUFRLEdBQUcsSUFBSSxPQUFPLENBQUMsUUFBUSxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ25ELFFBQVEsQ0FBQyxTQUFTLENBQUMsR0FBRyxFQUFFO1lBQ3BCLFFBQVEsQ0FBQyxHQUFHLENBQUMsOExBQThMLENBQUMsQ0FBQztZQUM3TSxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7UUFDdEIsQ0FBQyxDQUFDLENBQUM7SUFDUCxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUM7QUFFRCxtRUFBbUU7QUFFbkUsS0FBSyxVQUFVLFNBQVMsQ0FBQyxRQUFRLEVBQUUsc0JBQXNCO0lBQ3JELE9BQU8sSUFBSSxPQUFP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