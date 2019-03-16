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

    if (currentYearPdfUrls.length > 0) {
        let currentYearPdfUrl = currentYearPdfUrls.pop();
        selectedPdfUrls.push(currentYearPdfUrl);
        console.log(`Selected current year PDF: ${currentYearPdfUrl}`);
    }

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

    if (randomYearPdfUrls.length > 0) {
        let randomYearPdfUrl = randomYearPdfUrls[getRandom(0, randomYearPdfUrls.length)];
        selectedPdfUrls.push(randomYearPdfUrl);
        console.log(`Selected random year PDF: ${randomYearPdfUrl}`);
    }
    
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
