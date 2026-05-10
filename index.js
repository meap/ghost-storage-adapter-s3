'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

var _awsSdk = require('aws-sdk');

var _awsSdk2 = _interopRequireDefault(_awsSdk);

var _ghostStorageBase = require('ghost-storage-base');

var _ghostStorageBase2 = _interopRequireDefault(_ghostStorageBase);

var _path = require('path');

var _fs = require('fs');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

var readFileAsync = function readFileAsync(fp) {
  return new Promise(function (resolve, reject) {
    return (0, _fs.readFile)(fp, function (err, data) {
      return err ? reject(err) : resolve(data);
    });
  });
};
var stripLeadingSlash = function stripLeadingSlash(s) {
  return s.indexOf('/') === 0 ? s.substring(1) : s;
};
var stripEndingSlash = function stripEndingSlash(s) {
  return s.indexOf('/') === s.length - 1 ? s.substring(0, s.length - 1) : s;
};

class Store extends _ghostStorageBase2.default {
  constructor() {
    var config = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

    super(config);

    var accessKeyId = config.accessKeyId,
        assetHost = config.assetHost,
        bucket = config.bucket,
        pathPrefix = config.pathPrefix,
        region = config.region,
        secretAccessKey = config.secretAccessKey,
        endpoint = config.endpoint,
        serverSideEncryption = config.serverSideEncryption,
        forcePathStyle = config.forcePathStyle,
        signatureVersion = config.signatureVersion,
        acl = config.acl;

    // Compatible with the aws-sdk's default environment variables

    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = process.env.AWS_DEFAULT_REGION || region;

    this.bucket = process.env.GHOST_STORAGE_ADAPTER_S3_PATH_BUCKET || bucket;

    // Optional configurations
    this.host = process.env.GHOST_STORAGE_ADAPTER_S3_ASSET_HOST || assetHost || `https://s3${this.region === 'us-east-1' ? '' : `-${this.region}`}.amazonaws.com/${this.bucket}`;
    this.pathPrefix = stripLeadingSlash(process.env.GHOST_STORAGE_ADAPTER_S3_PATH_PREFIX || pathPrefix || '');
    this.endpoint = process.env.GHOST_STORAGE_ADAPTER_S3_ENDPOINT || endpoint || '';
    this.serverSideEncryption = process.env.GHOST_STORAGE_ADAPTER_S3_SSE || serverSideEncryption || '';
    this.s3ForcePathStyle = Boolean(process.env.GHOST_STORAGE_ADAPTER_S3_FORCE_PATH_STYLE) || Boolean(forcePathStyle) || false;
    this.signatureVersion = process.env.GHOST_STORAGE_ADAPTER_S3_SIGNATURE_VERSION || signatureVersion || 'v4';
    // Default to 'none' (skip the ACL parameter on PutObject) because all
    // S3 buckets created after April 2023 default to Object Ownership =
    // BucketOwnerEnforced, which rejects any request that includes an ACL.
    // Set GHOST_STORAGE_ADAPTER_S3_ACL=public-read (or pass `acl` in config)
    // to opt back into the upstream behaviour for legacy buckets.
    this.acl = process.env.GHOST_STORAGE_ADAPTER_S3_ACL || acl || 'none';

    // Required by Ghost 6's legacy ImageHandler during ZIP import.
    // `core/server/data/importer/handlers/image.js:18` reads this property
    // unguarded as `store.staticFileURLPrefix.split('/')`. Without it the
    // entire WordPress→Ghost ZIP import crashes with
    // `Cannot read properties of undefined (reading 'split')`.
    // Value matches Ghost's built-in `urlUtils.STATIC_IMAGE_URL_PREFIX`.
    this.staticFileURLPrefix = '/content/images';
  }

  delete(fileName, targetDir) {
    var _this = this;

    var directory = targetDir || this.getTargetDir(this.pathPrefix);

    return new Promise(function (resolve, reject) {
      _this.s3().deleteObject({
        Bucket: _this.bucket,
        Key: stripLeadingSlash((0, _path.join)(directory, fileName))
      }, function (err) {
        return err ? resolve(false) : resolve(true);
      });
    });
  }

  exists(fileName, targetDir) {
    var _this2 = this;

    return new Promise(function (resolve, reject) {
      _this2.s3().getObject({
        Bucket: _this2.bucket,
        Key: stripLeadingSlash((0, _path.join)(targetDir, fileName))
      }, function (err) {
        return err ? resolve(false) : resolve(true);
      });
    });
  }

  s3() {
    var options = {
      bucket: this.bucket,
      region: this.region,
      signatureVersion: this.signatureVersion,
      s3ForcePathStyle: this.s3ForcePathStyle

      // Set credentials only if provided, falls back to AWS SDK's default provider chain
    };if (this.accessKeyId && this.secretAccessKey) {
      options.credentials = new _awsSdk2.default.Credentials(this.accessKeyId, this.secretAccessKey);
    }

    if (this.endpoint !== '') {
      options.endpoint = this.endpoint;
    }
    return new _awsSdk2.default.S3(options);
  }

  save(image, targetDir) {
    var _this3 = this;

    var directory = targetDir || this.getTargetDir(this.pathPrefix);

    return new Promise(function (resolve, reject) {
      Promise.all([_this3.getUniqueFileName(image, directory), readFileAsync(image.path)]).then(function (_ref) {
        var _ref2 = _slicedToArray(_ref, 2),
            fileName = _ref2[0],
            file = _ref2[1];

        var config = {
          Body: file,
          Bucket: _this3.bucket,
          CacheControl: `max-age=${30 * 24 * 60 * 60}`,
          ContentType: image.type,
          Key: stripLeadingSlash(fileName)
          // Buckets with Object Ownership = BucketOwnerEnforced (the default for
          // buckets created after April 2023) reject any request that includes
          // an ACL. Set GHOST_STORAGE_ADAPTER_S3_ACL=none (or pass acl: 'none')
          // to skip the parameter entirely; reads are expected to go through a
          // bucket policy / CloudFront in that setup.
        };if (_this3.acl && _this3.acl !== 'none') {
          config.ACL = _this3.acl;
        }
        if (_this3.serverSideEncryption !== '') {
          config.ServerSideEncryption = _this3.serverSideEncryption;
        }
        _this3.s3().putObject(config, function (err, data) {
          return err ? reject(err) : resolve(`${_this3.host}/${fileName}`);
        });
      }).catch(function (err) {
        return reject(err);
      });
    });
  }

  serve() {
    var _this4 = this;

    return function (req, res, next) {
      return _this4.s3().getObject({
        Bucket: _this4.bucket,
        Key: stripLeadingSlash(stripEndingSlash(_this4.pathPrefix) + req.path)
      }).on('httpHeaders', function (statusCode, headers, response) {
        return res.set(headers);
      }).createReadStream().on('error', function (err) {
        res.status(404);
        next(err);
      }).pipe(res);
    };
  }

  read(options) {
    var _this5 = this;

    options = options || {};

    return new Promise(function (resolve, reject) {
      var path = (options.path || '').replace(/\/$|\\$/, '');
      var key = _this5._resolveKey(path);
      if (key === null) {
        reject(new Error(`${path} is not stored in s3`));
        return;
      }

      _this5.s3().getObject({
        Bucket: _this5.bucket,
        Key: key
      }, function (err, data) {
        return err ? reject(err) : resolve(data.Body);
      });
    });
  }

  // Maps the variety of "paths" Ghost may pass to read() into the S3 Key for
  // the underlying object. Returns null if the path clearly doesn't belong to
  // this adapter.
  //
  // Forms handled:
  //   1. `${this.host}/<key>`
  //        Image URL produced by save() — strip the host prefix.
  //   2. `<scheme>://<site>/.../content/images/<rest>`
  //   3. `/content/images/<rest>` (site-relative)
  //        Used when the post body references an image with the standard
  //        Ghost `/content/images/` URL — for example after a bulk migration
  //        that uploaded binaries straight to S3 instead of through save().
  //        Without this branch Ghost's image-transform middleware can't read
  //        the original to produce resized variants and falls back to a 302
  //        redirect to the full-size image, defeating responsive images.
  _resolveKey(path) {
    if (!path) return null;

    if (path.startsWith(this.host)) {
      return stripLeadingSlash(path.substring(this.host.length));
    }

    var marker = '/content/images/';
    var idx = path.indexOf(marker);
    if (idx === -1) return null;

    var tail = path.substring(idx + marker.length);
    var prefix = stripEndingSlash(this.pathPrefix || '');
    return stripLeadingSlash(prefix ? `${prefix}/${tail}` : tail);
  }
}

exports.default = Store;
module.exports = exports['default'];
