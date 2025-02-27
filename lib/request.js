module.exports = regRequest

// npm: means
// 1. https
// 2. send authorization
// 3. content-type is 'application/json' -- metadata
//
var assert = require('assert')
var url = require('url')
var zlib = require('zlib')
var Stream = require('stream').Stream
var STATUS_CODES = require('http').STATUS_CODES

var request = require('request')
var once = require('once')

function regRequest (uri, params, cb_) {
  assert(typeof uri === 'string', 'must pass uri to request')
  assert(params && typeof params === 'object', 'must pass params to request')
  assert(typeof cb_ === 'function', 'must pass callback to request')

  params.method = params.method || 'GET'
  this.log.verbose('request', 'uri', uri)

  // Since there are multiple places where an error could occur,
  // don't let the cb be called more than once.
  var cb = once(cb_)

  if (uri.match(/^\/?favicon.ico/)) {
    return cb(new Error("favicon.ico isn't a package, it's a picture."))
  }

  var adduserChange = /\/?-\/user\/org\.couchdb\.user:([^/]+)\/-rev/
  var isUserChange = uri.match(adduserChange)
  var adduserNew = /\/?-\/user\/org\.couchdb\.user:([^/?]+)$/
  var isNewUser = uri.match(adduserNew)
  var alwaysAuth = params.auth && params.auth.alwaysAuth
  var isDelete = params.method === 'DELETE'
  var isWrite = params.body || isDelete

  if (isUserChange && !isWrite) {
    return cb(new Error('trying to change user document without writing(?!)'))
  }

  if (params.authed == null) {
    // new users can *not* use auth, because they don't *have* auth yet
    if (isUserChange) {
      this.log.verbose('request', 'updating existing user; sending authorization')
      params.authed = true
    } else if (isNewUser) {
      this.log.verbose('request', "new user, so can't send auth")
      params.authed = false
    } else if (alwaysAuth) {
      this.log.verbose('request', 'always-auth set; sending authorization')
      params.authed = true
    } else {
      // most of the time we don't want to auth
      this.log.verbose('request', 'no auth needed')
      params.authed = false
    }
  }

  var self = this
  this.attempt(function (operation) {
    makeRequest.call(self, uri, params, function (er, parsed, raw, response) {
      if (response) {
        self.log.verbose('headers', response.headers)
        if (response.headers['npm-notice']) {
          self.log.warn('notice', response.headers['npm-notice'])
        }
      }

      if (!er || (er.message && er.message.match(/^SSL Error/))) {
        if (er) er.code = 'ESSL'
        return cb(er, parsed, raw, response)
      }

      // Only retry on 408, 5xx or no `response`.
      var statusCode = response && response.statusCode

      var timeout = statusCode === 408
      var serverError = statusCode >= 500
      var statusRetry = !statusCode || timeout || serverError
      if (er && statusRetry && operation.retry(er)) {
        self.log.info('retry', 'will retry, error on last attempt: ' + er)
        return undefined
      }
      cb.apply(null, arguments)
    })
  })
}

function makeRequest (uri, params, cb_) {
  var socket
  var cb = once(function (er, parsed, raw, response) {
    if (socket) {
      // The socket might be returned to a pool for re-use, so don’t keep
      // the 'error' listener from here attached.
      socket.removeListener('error', cb)
    }

    return cb_(er, parsed, raw, response)
  })

  var parsed = url.parse(uri)
  var headers = {}

  // metadata should be compressed
  headers['accept-encoding'] = 'gzip'

  // metadata should be minified, if the registry supports it

  var er = this.authify(params.authed, parsed, headers, params.auth)
  if (er) return cb_(er)

  var useCorgi = params.fullMetadata == null ? false : !params.fullMetadata

  var opts = this.initialize(
    parsed,
    params.method,
    useCorgi ? 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*' : 'application/json',
    headers
  )

  opts.followRedirect = (typeof params.follow === 'boolean' ? params.follow : true)
  opts.encoding = null // tell request let body be Buffer instance

  if (params.etag) {
    this.log.verbose('etag', params.etag)
    headers[params.method === 'GET' ? 'if-none-match' : 'if-match'] = params.etag
  }

  if (params.lastModified && params.method === 'GET') {
    this.log.verbose('lastModified', params.lastModified)
    headers['if-modified-since'] = params.lastModified
  }

  // figure out wth body is
  if (params.body) {
    if (Buffer.isBuffer(params.body)) {
      opts.body = params.body
      headers['content-type'] = 'application/json'
      headers['content-length'] = params.body.length
    } else if (typeof params.body === 'string') {
      opts.body = params.body
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(params.body)
    } else if (params.body instanceof Stream) {
      headers['content-type'] = 'application/octet-stream'
      if (params.body.size) headers['content-length'] = params.body.size
    } else {
      delete params.body._etag
      delete params.body._lastModified
      opts.json = params.body
    }
  }

  this.log.http('request', params.method, parsed.href || '/')

  var done = requestDone.call(this, params.method, uri, cb)
  var req = request(opts, params.streaming ? undefined : decodeResponseBody(done))

  req.on('error', cb)

  // This should not be necessary, as the HTTP implementation in Node
  // passes errors occurring on the socket to the request itself. Being overly
  // cautious comes at a low cost, though.
  req.on('socket', function (s) {
    socket = s
    socket.on('error', cb)
  })

  if (params.streaming) {
    req.on('response', function (response) {
      if (response.statusCode >= 400) {
        var parts = []
        response.on('data', function (data) {
          parts.push(data)
        })
        response.on('end', function () {
          decodeResponseBody(done)(null, response, Buffer.concat(parts))
        })
      } else {
        response.on('end', function () {
          // don't ever re-use connections that had server errors.
          // those sockets connect to the Bad Place!
          if (response.socket && response.statusCode > 500) {
            response.socket.destroy()
          }
        })

        return cb(null, response)
      }
    })
  }

  if (params.body && (params.body instanceof Stream)) {
    params.body.pipe(req)
  }
}

function decodeResponseBody (cb) {
  return function (er, response, data) {
    if (er) return cb(er, response, data)

    // don't ever re-use connections that had server errors.
    // those sockets connect to the Bad Place!
    if (response.socket && response.statusCode > 500) {
      response.socket.destroy()
    }

    if (response.headers['content-encoding'] !== 'gzip') {
      return cb(er, response, data)
    }

    zlib.gunzip(data, function (er, buf) {
      if (er) return cb(er, response, data)

      cb(null, response, buf)
    })
  }
}

// cb(er, parsed, raw, response)
function requestDone (method, where, cb) {
  return function (er, response, data) {
    if (er) return cb(er)

    var urlObj = url.parse(where)
    if (urlObj.auth) urlObj.auth = '***'
    this.log.http(response.statusCode, url.format(urlObj))

    if (Buffer.isBuffer(data)) {
      data = data.toString()
    }

    var parsed
    if (data && typeof data === 'string' && response.statusCode !== 304) {
      try {
        parsed = JSON.parse(data)
      } catch (ex) {
        ex.message += '\n' + data
        this.log.verbose('bad json', data)
        this.log.error('registry', 'error parsing json')
        return cb(ex, null, data, response)
      }
    } else if (data) {
      parsed = data
      data = JSON.stringify(parsed)
    }

    // expect data with any error codes
    if (!data && response.statusCode >= 400) {
      var code = response.statusCode
      return cb(
        makeError(code + ' ' + STATUS_CODES[code], null, code),
        null,
        data,
        response
      )
    }

    er = null
    if (parsed && response.headers.etag) {
      parsed._etag = response.headers.etag
    }

    if (parsed && response.headers['last-modified']) {
      parsed._lastModified = response.headers['last-modified']
    }

    // for the search endpoint, the 'error' property can be an object
    if ((parsed && parsed.error && typeof parsed.error !== 'object') ||
        response.statusCode >= 400) {
      var w = url.parse(where).pathname.substr(1)
      var name
      if (!w.match(/^-/)) {
        w = w.split('/')
        var index = w.indexOf('_rewrite')
        if (index === -1) {
          index = w.length - 1
        } else {
          index++
        }
        name = decodeURIComponent(w[index])
      }

      if (!parsed.error) {
        if (response.statusCode === 401 && response.headers['www-authenticate']) {
          const auth = response.headers['www-authenticate'].split(/,\s*/).map(s => s.toLowerCase())
          if (auth.indexOf('ipaddress') !== -1) {
            er = makeError('Login is not allowed from your IP address', name, response.statusCode, 'EAUTHIP')
          } else if (auth.indexOf('otp') !== -1) {
            er = makeError('OTP required for this operation', name, response.statusCode, 'EOTP')
          } else {
            er = makeError('Unable to authenticate, need: ' + response.headers['www-authenticate'], name, response.statusCode, 'EAUTHUNKNOWN')
          }
        } else {
          const msg = parsed.message ? ': ' + parsed.message : ''
          er = makeError(
            'Registry returned ' + response.statusCode +
            ' for ' + method +
            ' on ' + where +
            msg,
            name,
            response.statusCode
          )
        }
      } else if (name && parsed.error === 'not_found') {
        er = makeError('404 Not Found: ' + name, name, response.statusCode)
      } else if (name && parsed.error === 'User not found') {
        er = makeError('User not found. Check `npm whoami` and make sure you have a NPM account.', name, response.statusCode)
      } else {
        er = makeError(
          parsed.error + ' ' + (parsed.reason || '') + ': ' + (name || w),
          name,
          response.statusCode
        )
      }
    }
    return cb(er, parsed, data, response)
  }.bind(this)
}

function makeError (message, name, statusCode, code) {
  var er = new Error(message)
  if (name) er.pkgid = name
  if (statusCode) {
    er.statusCode = statusCode
    er.code = code || 'E' + statusCode
  }
  return er
}
