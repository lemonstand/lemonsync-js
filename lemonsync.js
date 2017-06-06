var AWS      = require('aws-sdk'),
    s3       = new AWS.S3(),
    request  = require('request'),
    fs       = require('fs'),
    readline = require('readline');

/**
 * S3 security variables
 */
var accessKeyId,
    secretAccessKey,
    sessionToken,
    bucket,
    prefix,
    store;

var watchDir = __dirname,
    theme = watchDir.match(/([^\/]*)\/*$/)[1],
    storeName,
    apiKey,
    localConfig = 'lemonsync.json';

readConfig();

function readConfig() {
    var config = fs.readFileSync(localConfig, 'utf8');
    var json = JSON.parse(config);
    storeName = json.store;
    apiKey = json.api_key;
    getIdentity(
        apiKey,
        getS3ListOfObjects // callback on completion
    );
}

/**
 * @param s3Files - array of key/body objects that make up a theme
 */
function compareS3FilesWithLocal(s3Files, prefix) {
    var changedLocalFiles = {};
    var changedRemoteFiles = {};
    var newLocalFiles = {};
    var count = 0;

    var localFilePaths = listFullFilePaths(watchDir);
    localFilePaths.forEach( function( localFilePath, index ) {

        localFileBody = fs.readFileSync(localFilePath, 'utf8');
        count++;

        shortLocalPath = localFilePath.replace(watchDir, theme);

        if (shortLocalPath in s3Files) {
            // Local file exists in s3, compare bodies:
            if (s3Files[shortLocalPath] !== localFileBody) {
                // Files are different, store in array of changed files.
                changedLocalFiles[prefix + shortLocalPath] = localFileBody;
                changedRemoteFiles[localFilePath] = s3Files[shortLocalPath];
            }
        } else {
            // New remote file found, store in array of new files.
            newLocalFiles[prefix + shortLocalPath] = localFileBody;
        }
        if (localFilePaths.length == count) {
            numberChanged = Object.keys(changedLocalFiles).length;
            numberNew = Object.keys(newLocalFiles).length;

            if (numberChanged == 0) {
                console.log('Store theme and local theme match!')
                watchForChanges();
            } else {
                /**
                 * Interface for reading typed user input
                 */
                readInput = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout,
                    prompt: '🍋  >'
                });
                console.log(numberChanged + ' file[s] are different. Do you want to overwrite your local or remote files?\r\n');

                console.log('Type "local" to overwrite your local theme: /Users/tomcornall/Documents/themes/zest');
                console.log('Type "remote" to overwrite your store\'s theme: Zest\r\n');

                readInput.prompt();
                readInput.on('line', function(answer) {
                    if (answer == 'remote') {
                        uploadLocalToStore(changedLocalFiles);
                    } else if (answer == 'local') {
                        overwriteLocalWithStore(changedRemoteFiles);
                    } else {
                        watchForChanges();
                    }
                    readInput.close();
                });
            }

        }
    });
}

function overwriteLocalWithStore(changedFiles) {
    console.log('\r\nOverwriting local theme files...\r\n');
    var count = 0;

    for (var key in changedFiles) {
        if (changedFiles.hasOwnProperty(key)) {
            try {
                fs.writeFileSync(key, changedFiles[key]);
                console.log('- ' + key);
            } catch (err) {
                console.log(err, err.stack);
            }
        }
    }

    // Watch for changes can catch these local file writes if we run it instantly
    setTimeout(watchForChanges, 30);
}

function uploadLocalToStore(changedFiles) {
    var putObjectPromises = [];
    var cacheKeys = [];
    console.log('\r\nOverwriting store\'s theme...\r\n');
    var count = 0;

    for (var key in changedFiles) {
        var cacheKey = key.replace(prefix + theme + '/', '');

        cacheKeys.push(cacheKey);
        if (changedFiles.hasOwnProperty(key)) {
            var params = {
                Bucket: bucket,
                Key: key,
                Body: changedFiles[key]
            };

            var putObjectPromise = s3.putObject(params).promise();
            count++;
            putObjectPromises.push(putObjectPromise);
            if (putObjectPromises.length == Object.keys(changedFiles).length) {
                Promise.all(putObjectPromises).then(function(dataArray) {                    
                    /**
                     * Since this is overwriting store files, we need to update the cache
                     */
                    touchLSCache(cacheKeys);
                    cacheKeys.forEach(function(value) {
                        console.log('- ' + value.replace(prefix, ''));
                    })
                    watchForChanges();
                }).catch(function(err) {
                    console.log(err, err.stack);
                });
                
            }
        }
    }
}

function watchForChanges() {
    console.log('\r\n🍋  Watching for changes... 🍋\r\n');

    fs.watch(watchDir, {recursive: true}, function(eventType, filename) {
        if (filename) {            
            localFilePath = watchDir + '/' + filename;
            key = prefix + theme + '/' + filename;
            localFileBody = fs.readFileSync(localFilePath);
            // Reading local file to send to S3
            var params = {
                Bucket: bucket,
                Key: key,
                Body: localFileBody
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
                console.log("The API Access Token isn't valid for "+apiHost+". Please check that your Access Token is correct and not expired.");
            }
            if (response.statusCode != 200) {
                console.log("Could not connect to LemonStand! Didn't get 200!");
            } else {
                // Cache successfully updated.
            }
        }
    }

    request(options, callback);
}

/**
 * @param s3ObjectList - data returned in listObjectsV2 via http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#listObjectsV2-property
 * @param prefix - Example: "store-testetattaet-587d6a9cc922c/themes/"
 */
function getS3Objects(s3ObjectList, prefix) {
    var s3Files = {};

    if (s3ObjectList.isTruncated) {
        console.log("Too many store files! We truncated this list to our maximum sync size.");
    }

    s3ObjectList.Contents.forEach(function( s3FileObject, index) {
        var s3Path = s3FileObject.Key.replace(prefix, '');
        var params = {
            Bucket: bucket,
            Key: s3FileObject.Key
        };
        var getObjectPromise = s3.getObject(params).promise();
        getObjectPromise.then(function(data) {             
            s3FileBody = data.Body.toString('utf-8');
            s3Files[s3Path] = s3FileBody;

            if (Object.keys(s3Files).length === s3ObjectList.KeyCount) {
                // Done getting s3 objects
                compareS3FilesWithLocal(s3Files, prefix);
            }
        }).catch(function(err) {
            console.log(err, err.stack);
        });
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
    console.log('🍋  Connecting to your store... 🍋\r\n');
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
        if (!error && response.statusCode == 200) {
            var body = JSON.parse(body);

            if (response.statusCode == 401) {
                console.log("The API Access Token isn't valid for "+apiHost+". Please check that your Access Token is correct and not expired.");
            }

            if (response.statusCode != 200) {
                console.log("Could not connect to the LemonStand store.");
            } else {
            }

            cb(body.data);
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

    AWS.config.update({
        accessKeyId: identityData.key,
        secretAccessKey: identityData.secret,
        sessionToken: identityData.token,
    });

    var listObjectsV2Params = {
        Bucket: identityData.bucket,
        Prefix: prefix + identityData.theme,
        MaxKeys: 10000
    };

    s3.listObjectsV2(listObjectsV2Params, function(err, objects) {
        if (err) {
            console.log(err, err.stack);
        }
        else {
            getS3Objects(objects, prefix);
        }
    });
}