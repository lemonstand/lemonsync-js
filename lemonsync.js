var params = {
  Bucket: 'STRING_VALUE', /* required */
  ContinuationToken: 'STRING_VALUE',
  Delimiter: 'STRING_VALUE',
  EncodingType: url,
  FetchOwner: true || false,
  MaxKeys: 0,
  Prefix: 'STRING_VALUE',
  RequestPayer: requester,
  StartAfter: 'STRING_VALUE'
};
s3.listObjectsV2(params, function(err, data) {
  if (err) console.log(err, err.stack); // an error occurred
  else     console.log(data);           // successful response
});