import AWS from 'aws-sdk'
import BaseStore from 'ghost-storage-base'
import { join } from 'path'
import { readFile } from 'fs'

const readFileAsync = fp => new Promise((resolve, reject) => readFile(fp, (err, data) => err ? reject(err) : resolve(data)))
const stripLeadingSlash = s => s.indexOf('/') === 0 ? s.substring(1) : s
const stripEndingSlash = s => s.indexOf('/') === (s.length - 1) ? s.substring(0, s.length - 1) : s

class Store extends BaseStore {
  constructor (config = {}) {
    super(config)

    const {
      accessKeyId,
      assetHost,
      bucket,
      pathPrefix,
      region,
      secretAccessKey,
      endpoint,
      serverSideEncryption,
      forcePathStyle,
      signatureVersion,
      acl
    } = config

    // Compatible with the aws-sdk's default environment variables
    this.accessKeyId = accessKeyId
    this.secretAccessKey = secretAccessKey
    this.region = process.env.AWS_DEFAULT_REGION || region

    this.bucket = process.env.GHOST_STORAGE_ADAPTER_S3_PATH_BUCKET || bucket

    // Optional configurations
    this.host = process.env.GHOST_STORAGE_ADAPTER_S3_ASSET_HOST || assetHost || `https://s3${this.region === 'us-east-1' ? '' : `-${this.region}`}.amazonaws.com/${this.bucket}`
    this.pathPrefix = stripLeadingSlash(process.env.GHOST_STORAGE_ADAPTER_S3_PATH_PREFIX || pathPrefix || '')
    this.endpoint = process.env.GHOST_STORAGE_ADAPTER_S3_ENDPOINT || endpoint || ''
    this.serverSideEncryption = process.env.GHOST_STORAGE_ADAPTER_S3_SSE || serverSideEncryption || ''
    this.s3ForcePathStyle = Boolean(process.env.GHOST_STORAGE_ADAPTER_S3_FORCE_PATH_STYLE) || Boolean(forcePathStyle) || false
    this.signatureVersion = process.env.GHOST_STORAGE_ADAPTER_S3_SIGNATURE_VERSION || signatureVersion || 'v4'
    this.acl = process.env.GHOST_STORAGE_ADAPTER_S3_ACL || acl || 'public-read'

    // Required by Ghost 6's legacy ImageHandler during ZIP import.
    // `core/server/data/importer/handlers/image.js:18` reads this property
    // unguarded as `store.staticFileURLPrefix.split('/')`. Without it the
    // entire WordPress→Ghost ZIP import crashes with
    // `Cannot read properties of undefined (reading 'split')`.
    // Value matches Ghost's built-in `urlUtils.STATIC_IMAGE_URL_PREFIX`.
    this.staticFileURLPrefix = '/content/images'
  }

  delete (fileName, targetDir) {
    const directory = targetDir || this.getTargetDir(this.pathPrefix)

    return new Promise((resolve, reject) => {
      this.s3()
        .deleteObject({
          Bucket: this.bucket,
          Key: stripLeadingSlash(join(directory, fileName))
        }, (err) => err ? resolve(false) : resolve(true))
    })
  }

  exists (fileName, targetDir) {
    return new Promise((resolve, reject) => {
      this.s3()
        .getObject({
          Bucket: this.bucket,
          Key: stripLeadingSlash(join(targetDir, fileName))
        }, (err) => err ? resolve(false) : resolve(true))
    })
  }

  s3 () {
    const options = {
      bucket: this.bucket,
      region: this.region,
      signatureVersion: this.signatureVersion,
      s3ForcePathStyle: this.s3ForcePathStyle
    }

    // Set credentials only if provided, falls back to AWS SDK's default provider chain
    if (this.accessKeyId && this.secretAccessKey) {
      options.credentials = new AWS.Credentials(this.accessKeyId, this.secretAccessKey)
    }

    if (this.endpoint !== '') {
      options.endpoint = this.endpoint
    }
    return new AWS.S3(options)
  }

  save (image, targetDir) {
    const directory = targetDir || this.getTargetDir(this.pathPrefix)

    return new Promise((resolve, reject) => {
      Promise.all([
        this.getUniqueFileName(image, directory),
        readFileAsync(image.path)
      ]).then(([ fileName, file ]) => {
        let config = {
          ACL: this.acl,
          Body: file,
          Bucket: this.bucket,
          CacheControl: `max-age=${30 * 24 * 60 * 60}`,
          ContentType: image.type,
          Key: stripLeadingSlash(fileName)
        }
        if (this.serverSideEncryption !== '') {
          config.ServerSideEncryption = this.serverSideEncryption
        }
        this.s3()
          .putObject(config, (err, data) => err ? reject(err) : resolve(`${this.host}/${fileName}`))
      })
      .catch(err => reject(err))
    })
  }

  serve () {
    return (req, res, next) =>
      this.s3()
        .getObject({
          Bucket: this.bucket,
          Key: stripLeadingSlash(stripEndingSlash(this.pathPrefix) + req.path)
        })
        .on('httpHeaders', (statusCode, headers, response) => res.set(headers))
        .createReadStream()
        .on('error', err => {
          res.status(404)
          next(err)
        })
        .pipe(res)
  }

  read (options) {
    options = options || {}

    return new Promise((resolve, reject) => {
      const path = (options.path || '').replace(/\/$|\\$/, '')
      const key = this._resolveKey(path)
      if (key === null) {
        reject(new Error(`${path} is not stored in s3`))
        return
      }

      this.s3()
        .getObject({
          Bucket: this.bucket,
          Key: key
        }, (err, data) => err ? reject(err) : resolve(data.Body))
    })
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
  _resolveKey (path) {
    if (!path) return null

    if (path.startsWith(this.host)) {
      return stripLeadingSlash(path.substring(this.host.length))
    }

    const marker = '/content/images/'
    const idx = path.indexOf(marker)
    if (idx === -1) return null

    const tail = path.substring(idx + marker.length)
    const prefix = stripEndingSlash(this.pathPrefix || '')
    return stripLeadingSlash(prefix ? `${prefix}/${tail}` : tail)
  }
}

export default Store
