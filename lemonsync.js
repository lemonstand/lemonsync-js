
var AWS = require('aws-sdk');
var request = require('request');

getIdentity('http://testetattaet.local.io/api/v2/identity/s3', 'ewoViNsN9JMGFbjFNJ3oxroK1o7ufMkxeSb65HLS');

function getIdentity(api_host, api_code) {
    var options = {
        url: api_host,
        method: 'POST',
        headers: {
            'Authorization': 'Bearer '+api_code,
            'Content-Type': 'application/json'
        }
    };

    request(options, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var body = JSON.parse(body);
            if (response.statusCode == 401) {
                console.log("The API Access Token isn't valid for "+api_host+". Please check that your Access Token is correct and not expired.");
            }
            if (response.statusCode != 200) {
                console.log("Could not connect to LemonStand! Didn't get 200!");
            } else {
                console.log('got s3 data!')
            }

            useIdentity(body.data);
        }
    });

}

function useIdentity(data) {
    console.log(data.bucket);
    var creds = new AWS.Credentials({
        accessKeyId: data.key, secretAccessKey: data.secret, sessionToken: data.token
    });
    AWS.config.update({
        accessKeyId: data.key,
        secretAccessKey: data.secret,
        sessionToken: data.token,
    });
    var s3 = new AWS.S3();
        console.log('accessKeyId:'+data.key);
        console.log('secretAccessKey:'+data.secret);
        console.log('sessionToken:'+data.token);
        console.log('bucket:'+data.bucket);
    var params = {
        Bucket: data.bucket,
        Prefix: data.store + '/themes/' + data.theme
    };

    s3.listObjectsV2(params, function(err, data) {
        if (err) {
            console.log(err, err.stack);
        }
        else {
            console.log(data);
            console.log('got AWS data!');
        }
    });
}
