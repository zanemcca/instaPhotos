// dependencies
var async = require('async');
var AWS = require('aws-sdk');
var sns = new AWS.SNS({apiVersion: '2010-03-31'});
var gm = require('gm').subClass({ imageMagick: true }); // Enable ImageMagick integration.
var util = require('util');

// get reference to S3 client 
var s3 = new AWS.S3();

exports.handler = function(event, context) {
  // Read options from the event.
  console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));

  var srcBucket = '';
  var srcKey = '';  

  if(event.Records && event.Records.length) {
    srcBucket = event.Records[0].s3.bucket.name;
    // Object key may have spaces or unicode non-ASCII characters.
    srcKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));  
  } else {
    srcBucket = event.container;
    srcKey = event.name;
  }

  var dstBucket = srcBucket.slice(0, srcBucket.lastIndexOf('-in'));

  if(dstBucket === srcBucket) {
    console.error('the source and destination buckets must be different\nsrc = ' + srcBucket + '\tdest = ' + dstBucket);
    return;
  }

  // Infer the image type.
  var typeMatch = srcKey.match(/\.([^.]*)$/);
  if (!typeMatch) {
    console.error('unable to infer image type for key ' + srcKey);
    return;
  }
  var imageType = typeMatch[1];
  if (imageType != "jpg" && imageType != "png") {
    console.log('skipping non-image ' + srcKey);
    return;
  }

  var MAX_FILE_SIZE = 500*1024;
  var MAX_BYTES_PER_PIXEL = MAX_FILE_SIZE/(960*960*0.75);

  var sizes = [
    /*
       {
       max: 1366,
       prefix: 'XXL'
       },
       {
       max: 1200,
       prefix: 'XL'
       },
       */
    {
      max: 960,
      prefix: 'L'
    },
    {
      max: 640,
      prefix: 'M'
    },
    {
      max: 380,
      prefix: 'S'
    },
    {
      max: 260,
      prefix: 'XS'
    },
    {
      max: 128,
      prefix: 'thumbnail'
    }];

    // Download the image from S3, transform, and upload to a different S3 bucket.
    async.waterfall([
      function download(next) {
        // Download the image from S3 into a buffer.
        s3.getObject({
          Bucket: srcBucket,
          Key: srcKey
        },
        next);
      },
      function transform(response, next) {
        gm(response.Body).size(function(err, size) {
          var completed = 0;
          var errors = [];

          var results = [];
          var done = function (res) {
            completed++;
            if(res) {
              results.push(res);
            }
            if(completed === sizes.length) {
              next(errors, results);
            }
          };

          var bytesPerPixel = response.ContentLength/(size.width * size.height);
          var quality = MAX_BYTES_PER_PIXEL/bytesPerPixel;
          var self = this;

          if(quality < 1) {
            var minQuality = 80; //The minimum quality value to give
            quality = Math.floor(quality*(100 - minQuality) + minQuality);
            console.log('Quality: ' + quality);
            self = self.quality(quality);
          }

          sizes.forEach(function (newSize) {
            var max = newSize.max;
            var dstKey = newSize.prefix + '-' + srcKey;

            // Infer the scaling factor to avoid stretching the image unnaturally.
            var scalingFactor = Math.min(
              max / size.width,
              max / size.height
            );

            if(scalingFactor >= 1) {
              console.log('Skipping because resolution of input image is below ' + max);
              done();
              return;
            }

            //Scale and round the new resolutions to their nearest even number
            var width  = 2 * Math.round(scalingFactor * size.width / 2);
            var height = 2 * Math.floor(scalingFactor * size.height / 2);

            var result = {
              width: width,
              height: height,
              prefix: newSize.prefix 
            };

            // Transform the image buffer in memory.
            self.resize(width, height)
            .toBuffer(imageType, function(err, buffer) {
              if (err) {
                console.error(err);
                errors.push(err);
                done();
              } else {
                // Stream the transformed image to a different S3 bucket.
                s3.putObject({
                  Bucket: dstBucket,
                  Key: dstKey,
                  Body: buffer,
                  ContentType: response.ContentType
                }, function (err) {
                  console.log(
                    'Successfully completed: ' + dstKey
                  );
                  if(err) {
                    console.error(err);
                    errors.push(err);
                    done();
                  } else {
                    done(result);
                  }
                });
              }
            });
          });
        });
      }
    ], function (errors, results) {
      var params = {
        Message: JSON.stringify({
          jobId: srcKey,
          sources: results
        }),
        TopicArn: 'arn:aws:sns:us-east-1:352985362696:image-transcoding-finished'
      };

      sns.publish(params, function(err, data) {
        if (err) {
          errors.push(err);
        }

        if (errors && errors.length) {
          console.error(
            'Unable to resize ' + srcBucket + '/' + srcKey +
              ' and upload to ' + dstBucket +
                ' due to '+ errors.length + ' error(s)!');
                errors.forEach(function (err) {
                  console.error(err);
                });
                context.fail('There were ' + errors.length + ' error(s) during imageTranscoding on ' + srcKey);
        } else {
          console.log(
            'Successfully resized ' + srcBucket + '/' + srcKey +
              ' and uploaded to ' + dstBucket
          );
          console.log(data);           // successful response
          context.succeed('Successful completion of imageTranscoding on ' + srcKey);
        }
      });
    });
};
