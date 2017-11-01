#!/usr/bin/env node
var AWS      = require('aws-sdk'),
    s3,
    request  = require('request'),
    fs       = require('fs'),
    readline = require('readline'),
    mkdirp   = require('mkdirp'),
    pathModule = require('path'),
    ignore = require("ignore"),
    rimraf = require("rimraf"),
    mime = require('mime');

/** Some CLI defaults */
var defaults = {
    scanTimeout: 30,
    s3Timeout: 300000, /* 5 minutes */
    maximumFileCount: 10000
};

/**
 * S3 security variables
 */
var accessKeyId,
    secretAccessKey,
    sessionToken,
    bucket,
    prefix,
    store;

var watchDir = process.cwd(),
    theme = watchDir.match(/([^\/\\]*)(\/\\)*$/)[1],
    storeName,
    apiKey,
    localConfig = 'lemonsync.json',
    ign,
    verbose = false;


processGlobalCommandLine();
loadPrivateHelpers();
readConfig();

function readConfig() {
    if (fs.existsSync(localConfig)) {
        var config = fs.readFileSync(localConfig, 'utf8');
        var json = JSON.parse(config);
        if (json.theme_code) {
            theme = json.theme_code;
        } else {
            console.log('Field "theme_code" not found in lemonsync.json, please add this field.');
            return;
        }
        if (json.store) {
            storeName = json.store;
        } else {
            console.log('Field "store" not found in lemonsync.json, please add this field.');
            return;
        }
        /**
         * Strips trailing slash
         */
        storeName = storeName.replace(/\/$/, "");
        if (json.api_token) {
            apiKey = json.api_token;
        } else {
            console.log('Field "api_token" not found in lemonsync.json, please add this field.');
            return;
        }
        var ignorePatterns = json.ignore_patterns;
        ign = ignore().add(ignorePatterns);
        getIdentity(
            apiKey,
            getS3ListOfObjects // callback on completion
        );
    } else {
        console.log('🍋  Please create a lemonsync.json file, see our wiki for more information: https://github.com/tomcornall/lemonsync-js 🍋');
    }
}

function emptyLocalFolder(path) {
    console.details('DELETE', 'Clearing local folder before syncing down');
    fs.readdirSync(path).forEach(function(file, index) {
        if (file == 'lemonsync.json') {
            console.details('DELETE', 'Skipping LemonSync configuration');
            return;
        }
        var curPath = path + pathModule.sep + file;
        if(fs.lstatSync(curPath).isDirectory()) { // recurse
            rimraf.sync(curPath);
        } else { // delete file
            fs.unlinkSync(curPath);
        }
    });
}

/**
 * @param s3Files - array of key/body objects that make up a theme
 */
function compareS3FilesWithLocal(s3Files, prefix) {
    var matchingFiles = {};
    var changedLocalFiles = {};
    var changedRemoteFiles = {};
    var newLocalFiles = {};
    var newS3Files = {};
    var count = 0;
    var localPathMatchCount = 0;

    var localFilePaths = listFullFilePaths(watchDir);

    if (process.argv.includes('--reset=local')) {
        emptyLocalFolder(watchDir);
        localFilePaths = listFullFilePaths(watchDir);
    }

    /**
     * Interface for reading typed user input
     */
    readInput = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '🍋  >'
    });

    /**
     * Ignore file patterns
     */
    localFilePaths = ign.filter(localFilePaths);

    localFilePaths.forEach( function( localFilePath, index ) {

        localFileBody = fs.readFileSync(localFilePath);
        count++;

        shortLocalPath = localFilePath.replace(watchDir, theme);

        if (shortLocalPath in s3Files) {
            localPathMatchCount++;
            // Local file exists in s3, compare bodies:
            if (!s3Files[shortLocalPath].equals(localFileBody)) {
                // Files are different, store in array of changed files.
                changedLocalFiles[prefix + shortLocalPath] = localFileBody;
                changedRemoteFiles[localFilePath] = s3Files[shortLocalPath];
            } else {
                matchingFiles[localFilePath] = localFileBody;
            }
        } else {
            if (localFileBody) {
                // New local file found, store in array of new files.
                newLocalFiles[prefix + shortLocalPath] = localFileBody;
            }
        }

        if (localFilePaths.length == count) {
            for (var key in s3Files) {
                if (s3Files.hasOwnProperty(key)) {
                    localKey = key.replace(theme, watchDir);
                    if (!(localKey in changedRemoteFiles) && !(localKey in matchingFiles)) {
                        // New remote file found, store in array of new files.
                        newS3Files[localKey] = s3Files[key];
                    }
                }
            }

            numberChanged = Object.keys(changedLocalFiles).length;
            numberNewLocal = Object.keys(newLocalFiles).length;
            numberNewS3 = Object.keys(newS3Files).length;

                // combine objects
                Object.assign(changedLocalFiles, newLocalFiles);
                Object.assign(changedRemoteFiles, newS3Files);

                if (process.argv.includes('--reset=local')) {
                    overwriteLocalWithStore(changedRemoteFiles);
                    return;
                }

                if (process.argv.includes('--reset=remote')) {
                    uploadLocalToStore(changedLocalFiles);
                    return;
                }

                if (numberNewLocal > 0) {
                    console.log(numberNewLocal + ' new local file(s) were found.');
                }

                if (numberNewS3 > 0) {
                    console.log(numberNewS3 + ' new store file(s) were found.');
                }

                if (localPathMatchCount == 0) {
                    console.log('No matching file names were found.');
                }

                if (numberChanged > 0) {
                    console.log(numberChanged + ' file(s) have changed.');
                }

                if (numberChanged == 0 && numberNewLocal == 0 && numberNewS3 == 0) {
                    watchForChanges();
                    return;
                }

                console.log('\r\nDo you want to overwrite your local or remote files?\r\n');

                console.log('Type "local" to overwrite your local theme: ' + watchDir);
                console.log('Type "remote" to overwrite your store\'s theme: ' + theme + '\r\n');
                console.log('Hit <enter> to begin watching for local changes.' + '\r\n');

                readInput.prompt();
                readInput.on('line', function(answer) {
                    if (answer == 'remote' && (numberNewLocal > 0 || numberChanged > 0)) {
                        uploadLocalToStore(changedLocalFiles);
                    } else if (answer == 'local' && (numberNewS3 > 0 || numberChanged > 0)) {
                        overwriteLocalWithStore(changedRemoteFiles);
                    } else if (answer == 'lemons') {
                        console.log('\r\n🍋 🍋 🍋 🍋 🍋 🍋 🍋  Yummy! 🍋 🍋 🍋 🍋 🍋 🍋 🍋\r\n');
                    } else if (answer == 'john lemon') {
                        console.log('██▛█████▜▛▀▀▞▜▜▜█▛▛▛█████████▜███▛███▛▛▀▛█▛█████████████████\r\n█▟▜▙▛██▛▌▌▜▐▐▟▜▛▌▛████████▛█▞▙▘▙▌▛▞▄█▌▌▛▛█████▜█▙█▜█████████\r\n█▟█▟███▟▙▀▞▖▙▜▜▟▟██▛█▛▙█▟▛▜▝▖▝▌▙▜▐▚▖▙▛▞▞███████████████▙█▟▙█\r\n█▟▟▙██▙▙▌▌▚▙▜▜▛▟▞▟▙▛▚▚█▟▚▚▀  ▝▞▟▝▞▖▝▙▌▜▟████████████████████\r\n█▟▙▙█▙█▛█▟▌▙▜▛▌▌▛▌▙▟▜▐▐ ▘   ▖▘▛ ▚▝▖▘ ▛▙█████▙███████████▙█▙█\r\n█▟▟▙███▛█▙▜▞█▜▜▐▐▐▙▜▝▖▖▚▘▝   ▚ ▝ ▚ ▘▘▐▐▙████████████████▜███\r\n█▟▙▜█▛▙█▙▛█▜█▜▞▞▞▙▌▙▚ ▗▘▘  ▖▚▘ ▗▝▗▝ ▚▝▞▜██████████████████▟█\r\n█▟▜█▛██▜▟██▐█▙▜▞▌▌▌▜  ▖ ▝ ▝▗▛    ▘ ▘▗▗▝▖▛█▙██████████▟███▜██\r\n█▟████▟██▜▞▙█▟█▞▌▌▞▐▌▖▗ ▝ ▗▐▖ ▗▝  ▗▝  ▖▞▐▐███████▛█▙██████▛█\r\n█▟▙████▜▟▛█▙██▙▛▌▌▖▖▌ ▗  ▝  ▘▖▖     ▖▘▖▝▝▞▞▛███▛▙████████▙██\r\n█▙███▟▜▛███▟▐▜▙█▚▘▗  ▘       ▝   ▖▘▗ ▖▞▐▝▗▚▜▚███████████████\r\n▙▛█▜▟▛██▟█▛▙▜▜▞█▚▚▖▞▄▖▚▗ ▖ ▗ ▖ ▗▗▗▞▄▙█▟▙█▙▙▙█████████████▙██\r\n█▛▛▙▛██▛███▛▜▀▞▜▛▛▞▘▘▀▜▟▙▚▌▖ ▖▝▗▚█▟██▛▀▀▛████▜▟█████████████\r\n▛█▜█▜█▟████▛▖▚▝▞▖▖▝▝███▟▟▛▙▝   ▖█▜█▚▄▟██▜▙▙▛██████████████▟█\r\n█▛█▟▛███████▖▗▝▖▖▖▄▄▄█▟▛▙▜▄ ▖▘▚▚██▚█▛▙▄▟▙█▟█▛███████████████\r\n█▜▛█▛█████▙▛▀▙▄▗▐▀▀▜█▜▚▀▀ ▚    ▝█▙█▜▜▀███████▜█████████▛▙█▙█\r\n█▜▛▙█████▙█   ▐   ▘▘ ▝ ▞ ▝▐    ▘▜▟▟▌▌▞▖▞▟▟▜▟▞▛▙█▙█████▜█████\r\n█▜▛█▟█▙▙█▙▛▞   ▗    ▖▖▘ ▗▗▘     ▜▟▞▜▐▗▞▞▄▙▜▐▐▐▟▙██████████▛█\r\n█▛█▜▙▙▙██▟▜▖    ▘▖      ▖▖      ▙▙▜▟▝▞▝▞▞▖▘▄▚▜▟█████▙███████\r\n█▜▛█▞███▙▛▙█      ▘▘  ▘▚▝       ▌█▚▚▜▞▄▖▄▐▚▙███▜██████████▜█\r\n███▙█▙█▟█▀▙▜▖▗      ▝▝▝        ▗▐███▐▐▐▞▙▛█▟█▙████▛█████████\r\n█▟▙█▙█▜█▜▛▛▛▞  ▖               ▖██▜█▌▌▖▚▚▜▜▛█████████████▟██\r\n█▛█▙███▟██▟▜▙▝  ▖       ▘     ▗▝▟▛▙█▛▞▞▞▞▟▛███████████▜▟██▙█\r\n██▛█▙█▟▛▙█▜▛▙▝ ▘ ▝       ▝▜▙▖▞▄▟████▜▞▞▐▐▙███▛███▛███████▙██\r\n█▟█▜▟█▙█▛█▚▛█ ▚▗▝           ▘▛███████▐▐▐▚▛██▜███▙███████████\r\n█▜▟██▟▜▙██▜█▜▚ ▖▗▝           ▞▛█████▟▙▙▜▚██▜██████████▛█▙█▛█\r\n███▜▟██▛███▟█▙▗   ▖▝ ▗ ▖▖▗▗ ▝▝▝▞▟█▜▟█▙▛▛█▜▟██████████▟██████\r\n█▙███▙███▟▛█▜▟▄▝ ▘    ▌▙▙▙▄▟▟▄▄▟▟███████▛██████▟███▛███▛▙███\r\n█▜▙█▟▛▙█▟█████▙▌▖▗ ▖ ▘▘▘  ▘▘▘▀▀▀▜▜▛█▛█▟▙██████▜███▜██▛████▙█\r\n██▜▛▙██▛█▟▙█▜███▖▖▖▗▝ ▘     ▚▚▟▟▛█▜▛█▙▙█▙██▛█▟███▟██▛████▜██\r\n█▟████▙███▜▟█▙█▙▜▄▗  ▘   ▗▝▝▞▌▛▙█▜▛█▙▛█▙███████████████▙████\r\n██▜▟█▟█▜█▟██▜█▜▀▞▐▐▐▗ ▖       ▝▝▝▝▞▚▚█▛███▙████████▙██▜███▜█\r\n█▟██▜█▟██▜▛▛▀   ▞▐▐▐▞▖ ▖         ▘▝▞▙████▜███████████████▟██\r\n██▜▟█▛█▜▞▛▝     ▖▘▖▚▐▜▚▗▗ ▖▗ ▖▗▘▞▐▞▟█▙██████████████████████\r\n█▟██▜▛▀▚▚▘       ▘▝▖▚▐▚▙▌▙▐▗▚▞▄▙▜▙██████▜███████████████████\r\n███▝▚▄█▟▟▌      ▝▟▄▄▙▄▙▙███████▟████▟██▟████████████████████');
                    } else if (answer == 'lemonstand') {
                        console.log('▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞█\r\n▙▜▝ ▘▝ ▘▝ ▀▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▟\r\n▞▙   ▞▀▗▄  █▞▚▜▞▌▀▝▚▜▝▙▜▝▙▜▝▘▀▐▙▀▞▙▀▞▌▀▝▌▀▝▘▜▞▘▛▟▘▜▞▌▛▝▘▀▐▙▜\r\n▜▟ ▗▀   ▝▖ ▙▜▝▙▜▚▝▘▛▙▗▝▌▖▞▌▞▛▟ ▞ ▞▞ ▛▖▀▙▜▞ ▛▟ ▌▜▞▖▖▜ ▜ ▛▟▖▞█\r\n▙▚ ▝▘   ▞  ▙▙▝▞▙▌▐▜▜▖▐▖▗▘▐▖▚▜▞▘▛▗▙▝ ▛▞▙ ▙▜ █▞▗▄ ▛ ▙▖▘▜ ▛▌▘▟▜\r\n▞▛  ▀▘▄▀   ▙▚▄▄▖▙▄▗▄▙▞▟▜▚▟▟▄▄▗▛▛▄▞▛▄▜▄▗▞▞▙▄▌▌▙▚▙▟▄▚▙▄▜▄▗▄▜▞█\r\n▜▜▄▄▗▖▖▖▖▄▐▞▛▟▐▞▙▚▛▟▐▞▙▙▜▞▄▌▙▜▞▙▙▜▜▞▙▚▛▟▜▟▞▟▜▞▙▚▌▙▜▞▞▙▚▛▞▙▜▟\r\n█▟▟▟▙█▟█▟▙█▟█▟▙█▟▙█▟▙█▟▟▙█▟▟▙█▟▟▟▙▙█▟▙█▟▙▙█▟▙█▟▙█▟▙██▟▙██▟▙█');
                    } else {
                        watchForChanges();
                    }
                    readInput.close();
                });

        }
    });

    if (localFilePaths.length === 0) {
        if (process.argv.includes('--reset=remote')) {
            console.log('Remote theme cannot be overwritten with an empty theme.');
        }

        for (var key in s3Files) {
            if (s3Files.hasOwnProperty(key)) {
                localKey = key.replace(theme, watchDir);
                // New remote file found, store in array of new files.
                newS3Files[localKey] = s3Files[key];
            }
        }

        if (process.argv.includes('--reset=local')) {
            overwriteLocalWithStore(newS3Files);
            return;
        } else {
            console.log('Your local theme folder is empty.');
        }

        numberNewS3 = Object.keys(newS3Files).length;

        if (numberNewS3 > 0) {
            console.log(numberNewS3 + ' new store file(s) were found.');
        } else {
            // Both S3 and local theme are empty
            console.log('No theme files were found locally or in your store.');
            watchForChanges();
            return;
        }

        console.log('\r\nDo you want to overwrite your local theme folder?\r\n');

        console.log('Type "local" to download your local theme: ' + watchDir);
        console.log('Hit <enter> to begin watching for local changes.' + '\r\n');

        readInput.prompt();
        readInput.on('line', function(answer) {
            if (answer == 'local' && (numberNewS3 > 0)) {
                overwriteLocalWithStore(newS3Files);
            } else if (answer == 'lemons') {
                console.log('\r\n🍋 🍋 🍋 🍋 🍋 🍋 🍋  Yummy! 🍋 🍋 🍋 🍋 🍋 🍋 🍋\r\n');
            } else if (answer == 'john lemon') {
                console.log('██▛█████▜▛▀▀▞▜▜▜█▛▛▛█████████▜███▛███▛▛▀▛█▛█████████████████\r\n█▟▜▙▛██▛▌▌▜▐▐▟▜▛▌▛████████▛█▞▙▘▙▌▛▞▄█▌▌▛▛█████▜█▙█▜█████████\r\n█▟█▟███▟▙▀▞▖▙▜▜▟▟██▛█▛▙█▟▛▜▝▖▝▌▙▜▐▚▖▙▛▞▞███████████████▙█▟▙█\r\n█▟▟▙██▙▙▌▌▚▙▜▜▛▟▞▟▙▛▚▚█▟▚▚▀  ▝▞▟▝▞▖▝▙▌▜▟████████████████████\r\n█▟▙▙█▙█▛█▟▌▙▜▛▌▌▛▌▙▟▜▐▐ ▘   ▖▘▛ ▚▝▖▘ ▛▙█████▙███████████▙█▙█\r\n█▟▟▙███▛█▙▜▞█▜▜▐▐▐▙▜▝▖▖▚▘▝   ▚ ▝ ▚ ▘▘▐▐▙████████████████▜███\r\n█▟▙▜█▛▙█▙▛█▜█▜▞▞▞▙▌▙▚ ▗▘▘  ▖▚▘ ▗▝▗▝ ▚▝▞▜██████████████████▟█\r\n█▟▜█▛██▜▟██▐█▙▜▞▌▌▌▜  ▖ ▝ ▝▗▛    ▘ ▘▗▗▝▖▛█▙██████████▟███▜██\r\n█▟████▟██▜▞▙█▟█▞▌▌▞▐▌▖▗ ▝ ▗▐▖ ▗▝  ▗▝  ▖▞▐▐███████▛█▙██████▛█\r\n█▟▙████▜▟▛█▙██▙▛▌▌▖▖▌ ▗  ▝  ▘▖▖     ▖▘▖▝▝▞▞▛███▛▙████████▙██\r\n█▙███▟▜▛███▟▐▜▙█▚▘▗  ▘       ▝   ▖▘▗ ▖▞▐▝▗▚▜▚███████████████\r\n▙▛█▜▟▛██▟█▛▙▜▜▞█▚▚▖▞▄▖▚▗ ▖ ▗ ▖ ▗▗▗▞▄▙█▟▙█▙▙▙█████████████▙██\r\n█▛▛▙▛██▛███▛▜▀▞▜▛▛▞▘▘▀▜▟▙▚▌▖ ▖▝▗▚█▟██▛▀▀▛████▜▟█████████████\r\n▛█▜█▜█▟████▛▖▚▝▞▖▖▝▝███▟▟▛▙▝   ▖█▜█▚▄▟██▜▙▙▛██████████████▟█\r\n█▛█▟▛███████▖▗▝▖▖▖▄▄▄█▟▛▙▜▄ ▖▘▚▚██▚█▛▙▄▟▙█▟█▛███████████████\r\n█▜▛█▛█████▙▛▀▙▄▗▐▀▀▜█▜▚▀▀ ▚    ▝█▙█▜▜▀███████▜█████████▛▙█▙█\r\n█▜▛▙█████▙█   ▐   ▘▘ ▝ ▞ ▝▐    ▘▜▟▟▌▌▞▖▞▟▟▜▟▞▛▙█▙█████▜█████\r\n█▜▛█▟█▙▙█▙▛▞   ▗    ▖▖▘ ▗▗▘     ▜▟▞▜▐▗▞▞▄▙▜▐▐▐▟▙██████████▛█\r\n█▛█▜▙▙▙██▟▜▖    ▘▖      ▖▖      ▙▙▜▟▝▞▝▞▞▖▘▄▚▜▟█████▙███████\r\n█▜▛█▞███▙▛▙█      ▘▘  ▘▚▝       ▌█▚▚▜▞▄▖▄▐▚▙███▜██████████▜█\r\n███▙█▙█▟█▀▙▜▖▗      ▝▝▝        ▗▐███▐▐▐▞▙▛█▟█▙████▛█████████\r\n█▟▙█▙█▜█▜▛▛▛▞  ▖               ▖██▜█▌▌▖▚▚▜▜▛█████████████▟██\r\n█▛█▙███▟██▟▜▙▝  ▖       ▘     ▗▝▟▛▙█▛▞▞▞▞▟▛███████████▜▟██▙█\r\n██▛█▙█▟▛▙█▜▛▙▝ ▘ ▝       ▝▜▙▖▞▄▟████▜▞▞▐▐▙███▛███▛███████▙██\r\n█▟█▜▟█▙█▛█▚▛█ ▚▗▝           ▘▛███████▐▐▐▚▛██▜███▙███████████\r\n█▜▟██▟▜▙██▜█▜▚ ▖▗▝           ▞▛█████▟▙▙▜▚██▜██████████▛█▙█▛█\r\n███▜▟██▛███▟█▙▗   ▖▝ ▗ ▖▖▗▗ ▝▝▝▞▟█▜▟█▙▛▛█▜▟██████████▟██████\r\n█▙███▙███▟▛█▜▟▄▝ ▘    ▌▙▙▙▄▟▟▄▄▟▟███████▛██████▟███▛███▛▙███\r\n█▜▙█▟▛▙█▟█████▙▌▖▗ ▖ ▘▘▘  ▘▘▘▀▀▀▜▜▛█▛█▟▙██████▜███▜██▛████▙█\r\n██▜▛▙██▛█▟▙█▜███▖▖▖▗▝ ▘     ▚▚▟▟▛█▜▛█▙▙█▙██▛█▟███▟██▛████▜██\r\n█▟████▙███▜▟█▙█▙▜▄▗  ▘   ▗▝▝▞▌▛▙█▜▛█▙▛█▙███████████████▙████\r\n██▜▟█▟█▜█▟██▜█▜▀▞▐▐▐▗ ▖       ▝▝▝▝▞▚▚█▛███▙████████▙██▜███▜█\r\n█▟██▜█▟██▜▛▛▀   ▞▐▐▐▞▖ ▖         ▘▝▞▙████▜███████████████▟██\r\n██▜▟█▛█▜▞▛▝     ▖▘▖▚▐▜▚▗▗ ▖▗ ▖▗▘▞▐▞▟█▙██████████████████████\r\n█▟██▜▛▀▚▚▘       ▘▝▖▚▐▚▙▌▙▐▗▚▞▄▙▜▙██████▜███████████████████\r\n███▝▚▄█▟▟▌      ▝▟▄▄▙▄▙▙███████▟████▟██▟████████████████████');
            } else if (answer == 'lemonstand') {
                console.log('▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞█\r\n▙▜▝ ▘▝ ▘▝ ▀▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▞▙▜▟\r\n▞▙   ▞▀▗▄  █▞▚▜▞▌▀▝▚▜▝▙▜▝▙▜▝▘▀▐▙▀▞▙▀▞▌▀▝▌▀▝▘▜▞▘▛▟▘▜▞▌▛▝▘▀▐▙▜\r\n▜▟ ▗▀   ▝▖ ▙▜▝▙▜▚▝▘▛▙▗▝▌▖▞▌▞▛▟ ▞ ▞▞ ▛▖▀▙▜▞ ▛▟ ▌▜▞▖▖▜ ▜ ▛▟▖▞█\r\n▙▚ ▝▘   ▞  ▙▙▝▞▙▌▐▜▜▖▐▖▗▘▐▖▚▜▞▘▛▗▙▝ ▛▞▙ ▙▜ █▞▗▄ ▛ ▙▖▘▜ ▛▌▘▟▜\r\n▞▛  ▀▘▄▀   ▙▚▄▄▖▙▄▗▄▙▞▟▜▚▟▟▄▄▗▛▛▄▞▛▄▜▄▗▞▞▙▄▌▌▙▚▙▟▄▚▙▄▜▄▗▄▜▞█\r\n▜▜▄▄▗▖▖▖▖▄▐▞▛▟▐▞▙▚▛▟▐▞▙▙▜▞▄▌▙▜▞▙▙▜▜▞▙▚▛▟▜▟▞▟▜▞▙▚▌▙▜▞▞▙▚▛▞▙▜▟\r\n█▟▟▟▙█▟█▟▙█▟█▟▙█▟▙█▟▙█▟▟▙█▟▟▙█▟▟▟▙▙█▟▙█▟▙▙█▟▙█▟▙█▟▙██▟▙██▟▙█');
            } else {
                watchForChanges();
            }
            readInput.close();
        });
    }
}

function overwriteLocalWithStore(changedFiles) {
    console.log('\r\nOverwriting local theme files...\r\n');
    var count = 0;

    for (var key in changedFiles) {
        if (changedFiles.hasOwnProperty(key)) {
            newKey = key.replace(/\/$/, "/__isDirectory__"); // Flag for future parsing
            if (pathModule.sep == '\\') {
                newKey = newKey.replace(/\//g,"\\");
            }
            if (newKey === key) {
                continue;
            }
            changedFiles[newKey] = changedFiles[key];
            delete changedFiles[key];
        }
    }

    for (var key in changedFiles) {
        if (changedFiles.hasOwnProperty(key)) {
            try {
                var path = pathModule.dirname(key);
                // Make the directory in case it doesn't already exist
                mkdirp.sync(path);

                if (key.match(/__isDirectory__/)) {
                    console.log('- ' + key.replace(/__isDirectory__/, ''));
                    continue;
                }

                fs.writeFileSync(key, changedFiles[key]);
                console.log('- ' + key);
            } catch (err) {
                console.log('Error overwriting local file (' + key + '): ' + err.message);
            }
        }
    }

    // Watch for changes can catch these local file writes if we run it instantly
    setTimeout(watchForChanges, defaults.scanTimeout);
}

function uploadLocalToStore(changedFiles) {
    var uploadList = [];
    var cacheKeys = [];
    var totalChanges = Object.keys(changedFiles).length;
    var count = 1;

    /** S3 file completion helper */
    var onFileUpdate = function(err, data) {
        if (err) {
            console.details('remote', 'Update failed', err);
        } else {
            console.details('remote', 'Update OK for', data.Location);
        }
    }

    console.log('\r\nOverwriting store\'s theme...\r\n');

    /** Queue up upload and cache list for sync with server */

    for (var key in changedFiles) {
        var cacheKey = key.replace(prefix + theme + '/', '');
        var fileSizeMB = changedFiles[key].length / 1024 / 1024;

        console.log('- ' + cacheKey.replace(prefix, ''));

        console.details('remote', 'Preparing changes for',
            cacheKey,
            '(', count, '/', totalChanges, ')',
            fileSizeMB.toFixed(2), 'MB');

        if (!changedFiles.hasOwnProperty(key)) {
            continue; // skip non-file object props
        }

        // track cache entry
        cacheKeys.push(cacheKey);

        // track upload
        var params = {
            Bucket: bucket,
            Key: key,
            Body: changedFiles[key],
            ContentType: mime.getType(key)
        };

        var themeFileUpdater = s3.upload(params, onFileUpdate)
                                    .promise();

        uploadList.push(themeFileUpdater);
        count++;
    }

    console.details('remote', 'Updating', uploadList.length, '/', totalChanges, 'files ...');

    // Upload files in a batch + tickle cache and continue watching

    Promise
        .all(uploadList)
        .then(function (dataArray) {

            console.details('remote', 'Update complete');

            /**
             * Since this is overwriting store files, we need to update the cache
             */
            touchLSCache(cacheKeys);

            watchForChanges();

        }).catch(function (err, data) {
            console.log('Error uploading to store theme: ' + err.message);
            console.details('remote', 'S3 upload failed with', err, data);
        });
}

function watchForChanges() {
    console.log('\r\n🍋  Watching for changes... 🍋\r\n');

    fs.watch(watchDir, {recursive: true}, function(eventType, filename) {
        watchTriggered(eventType, filename);
    });
}

function watchTriggered(eventType, filename) {
        if (filename) {
            localFilePath = watchDir + '/' + filename;

            if (ign.ignores(localFilePath)) {
                return;
            }

            if (pathModule.sep == '\\') {
                filename = filename.replace(/\\/g,"/");
            }

            key = prefix + theme + '/' + filename;

            // Get some stats on the file path
            try {
                access = fs.accessSync(localFilePath);
            } catch(err) {
                if (err.code === 'ENOENT') {
                    // ENOENT: no such file or directory found - this means watched file was renamed or deleted.
                    // Delete the file or folder in S3 and all files within.
                    params = {
                        Bucket: bucket + key
                    }
                    emptyBucket(key);
                    console.log(`- ${filename} deleted`);
                } else {
                    throw err;
                }
                return;
            }

            fileStats = fs.statSync(localFilePath);
            if (!fileStats) {
                // no stats found
                return;
            }

            if (fileStats.isDirectory()) {
                // Get everything in the watched directory
                var localFilePaths = listFullFilePaths(localFilePath);

                // Apply ignore file patterns
                localFilePaths = ign.filter(localFilePaths);

                localFilePaths.forEach( function( localFilePath, index ) {
                    shortLocalPath = localFilePath.replace(watchDir + pathModule.sep, '');

                    // Trigger watch event capture on each object within the directory
                    watchTriggered(eventType, shortLocalPath);
                });
                return;
            }

            localFileBody = fs.readFileSync(localFilePath);
            // Reading local file to send to S3
            var params = {
                Bucket: bucket,
                Key: key,
                Body: localFileBody,
                ContentType: mime.getType(localFilePath)
            };

            var putObjectPromise = s3.putObject(params).promise();
            putObjectPromise.then(function(data) {
                console.log(`- ${filename} touched`);
                var cacheKeys = [filename];
                touchLSCache(cacheKeys);
            }).catch(function(err) {
                console.log(err, err.stack);
            });
        } else {
            console.log('Filename not provided');
        }
}

function emptyBucket(prefix){
    var params = {
        Bucket: bucket,
        Prefix: prefix
    };

    s3.listObjectsV2(params, function(err, data) {
        if (err) throw err;

        if (data.Contents.length == 0) return;

        params = {
            Bucket: bucket
        };
        params.Delete = {Objects:[]};

        data.Contents.forEach(function(content) {
            params.Delete.Objects.push({Key: content.Key});
        });

        s3.deleteObjects(params, function(err, data) {
            if (err) throw err;
            if (data.Deleted.length == 1000) {
                // Max object delete reached, run again
                emptyBucket(prefix);
            }
        });
    });
}

/**
 * @param keys - example: [ "pages/about/page-about.htm" ]
 */
function touchLSCache(keys) {
    var apiHost = storeName + '/api/v2/resource/touch';

    var options = {
        url: apiHost,
        method: 'PUT',
        headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json'
        },
        json: { 'keys': keys }
    };

    function callback(error, response, body) {
        if (!error && response.statusCode == 200) {
            if (response.statusCode == 401) {
                console.log("The API Access Token isn't valid for " + apiHost + ". Please check that your Access Token is correct and not expired.");
            }
            if (response.statusCode != 200) {
                console.log("Could not connect to LemonStand! Didn't get 200!");
                console.details('cache', 'Cache update failed with', response.statusCode, response);
            } else {
                // Cache successfully updated.
                console.details('cache', 'Cache updated');
            }
        }
    }

    console.details('cache', 'Updating cache', apiHost);
    request(options, callback);
}

/**
 * @param s3ObjectList - data returned in listObjectsV2 via http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#listObjectsV2-property
 * @param prefix - Example: "store-testetattaet-587d6a9cc922c/themes/"
 */
function getS3Objects(s3ObjectList, prefix) {
    var s3Files = {};
    var count = 0;

    if (s3ObjectList.isTruncated) {
        console.log("Too many store files! We truncated this list to our maximum sync size.");
    }

    s3ObjectList.Contents.forEach(function( s3FileObject, index) {
        var s3Path = s3FileObject.Key.replace(prefix, '');
        var params = {
            Bucket: bucket,
            Key: s3FileObject.Key
        };
        if (process.argv.includes('--reset=remote')) {
            var deleteObjectPromise = s3.deleteObject(params).promise();
            deleteObjectPromise.then(function(data) {
                count++;
                if (count === s3ObjectList.KeyCount) {
                    // Done getting s3 objects
                    compareS3FilesWithLocal(s3Files, prefix);
                }
            }).catch(function(err) {
                console.log(err, err.stack);
            });
        } else {
            var getObjectPromise = s3.getObject(params).promise();
            getObjectPromise.then(function(data) {
                s3FileBody = data.Body;
                s3Files[s3Path] = s3FileBody;
                count++;
                if (count === s3ObjectList.KeyCount) {
                    // Done getting s3 objects
                    compareS3FilesWithLocal(s3Files, prefix);
                }
            }).catch(function(err) {
                console.log(err, err.stack);
            });
        }
    });
}

/**
 * List all files in a directory in Node.js recursively
 */
function listFullFilePaths(dir, filelist) {
    files = fs.readdirSync(dir);
    filelist = filelist || [];
    files.forEach(function(file) {
        if (fs.statSync(dir + '/' + file).isDirectory()) {
            filelist = listFullFilePaths(dir + '/' + file, filelist);
        }
        else {
            filelist.push(dir + '/' + file);
        }
    });
    return filelist;
};

/**
 * Get s3 identity data from store API /identity/s3 endpoint
 */
function getIdentity(apiKey, cb) {
    console.log('🍋  Connecting to your store (' + storeName + ') ... 🍋\r\n');
    var apiHost = storeName + '/api/v2/identity/s3';

    var options = {
        url: apiHost,
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json'
        }
    };

    function callback(error, response, body) {
        console.details('store', 'Connected with code', response.statusCode);
        if (!error && response.statusCode == 200) {
            var body = JSON.parse(body);
            cb(body.data);
        } else {
            if (error) {
                console.log("Could not connect to your store:");
                console.log(error.message);
                console.details('store', 'Connection failed with', response, body);
            }
            if (response) {
                if (response.statusCode == 401) {
                    console.log("The API Access Token isn't valid for " + apiHost + ". Please check that your Access Token is correct and not expired.");
                } else if (response.statusCode != 200) {
                    console.log("Could not connect to the LemonStand store.");
                }
            }
        }
    }

    request(options, callback);
}

function getS3ListOfObjects(identityData) {
    accessKeyId = identityData.key;
    secretAccessKey = identityData.secret;
    sessionToken = identityData.token;
    bucket = identityData.bucket;
    store = identityData.store;
    prefix = store + '/themes/';

    console.details('store', 'Getting store file listing for', store, theme);

    AWS.config.update({
        accessKeyId: identityData.key,
        secretAccessKey: identityData.secret,
        sessionToken: identityData.token,
        region: 'us-east-1',
        httpOptions: {
            timeout: defaults.s3Timeout
        }
    });

    s3 = new AWS.S3();

    var listObjectsV2Params = {
        Bucket: identityData.bucket,
        Prefix: prefix + theme + '/',
        MaxKeys: defaults.maximumFileCount
    };

    s3.listObjectsV2(listObjectsV2Params, function(err, objects) {
        if (err) {
            console.log(err, err.stack);
        }
        else {
            if (objects.KeyCount == 0) {
                console.log('We couldn\'t find the theme "' + theme + '" in your store. To continue, please create an empty theme with the same name.');
            }
            getS3Objects(objects, prefix);
        }
    });
}

// Register private helpers

function loadPrivateHelpers() {

    // Verbose trace helper
    console.details = function(type) {
        if (verbose) {
            var args = Array.prototype.slice.call(arguments, 1);
            var details = args.join(' ');
            console.log(type.toUpperCase() + ':', details);
        }
    }
}

function processGlobalCommandLine() {
    if (process.argv.includes('--version')) {
        packageJson = require(module.filename + '/../../package.json');
        console.log(packageJson.version);
    }

    if (process.argv.includes('--verbose')) {
        verbose = true;
        console.log('Detailed logging is ON');
    }

    if (process.argv.includes('--network-logging')) {
        request.debug = true;
        console.log('Network logging is ON');
    }
}