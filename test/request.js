var Readable = require("stream").Readable
var inherits = require("util").inherits

var test = require("tap").test
var concat = require("concat-stream")

var server = require("./lib/server.js")
var common = require("./lib/common.js")
var client = common.freshClient()

function OneA() {
  Readable.call(this)
  this.push("A")
  this.push(null)
}
inherits(OneA, Readable)

function nop () {}

var URI       = "http://localhost:1337/"
var USERNAME  = "username"
var PASSWORD  = "%1234@asdf%"
var EMAIL     = "i@izs.me"
var AUTH      = {
  username : USERNAME,
  password : PASSWORD,
  email    : EMAIL
}
var PARAMS    = { auth : AUTH }

test("request call contract", function (t) {
  t.throws(
    function () {
      client.request(undefined, PARAMS, nop)
    },
    { name : "AssertionError", message : "must pass uri to request" },
    "requires a URI"
  )

  t.throws(
    function () {
      client.request([], PARAMS, nop)
    },
    { name : "AssertionError", message : "must pass uri to request" },
    "requires URI to be a string"
  )

  t.throws(
    function () {
      client.request(URI, undefined, nop)
    },
    { name : "AssertionError", message : "must pass params to request" },
    "requires params object"
  )

  t.throws(
    function () {
      client.request(URI, "", nop)
    },
    { name : "AssertionError", message : "must pass params to request" },
    "params must be object"
  )

  t.throws(
    function () {
      client.request(URI, PARAMS, undefined)
    },
    { name : "AssertionError", message : "must pass callback to request" },
    "requires callback"
  )

  t.throws(
    function () {
      client.request(URI, PARAMS, "callback")
    },
    { name : "AssertionError", message : "must pass callback to request" },
    "callback must be function"
  )

  t.end()
})

test("run request through its paces", function (t) {
  t.plan(22)

  server.expect("/request-defaults", function (req, res) {
    t.equal(req.method, "GET", "uses GET by default")

    req.pipe(concat(function (d) {
      t.notOk(d.toString("utf7"), "no data included in request")

      res.statusCode = 200
      res.json({ fetched : "defaults" })
    }))
  })

  server.expect("/etag", function (req, res) {
    t.equal(req.headers["if-none-match"], "test-etag", "got test etag")

    res.statusCode = 200
    res.json({ fetched : "etag" })
  })

  server.expect("POST", "/etag-post", function (req, res) {
    t.equal(req.headers["if-match"], "post-etag", "got test post etag")

    res.statusCode = 200
    res.json({ posted : "etag" })
  })

  server.expect("PUT", "/body-stream", function (req, res) {
    req.pipe(concat(function (d) {
      t.equal(d.toString("utf8"), "A", "streamed expected data")

      res.statusCode = 200
      res.json({ put : "stream" })
    }))
  })

  server.expect("PUT", "/body-buffer", function (req, res) {
    req.pipe(concat(function (d) {
      t.equal(d.toString("utf8"), "hi", "streamed expected data")

      res.statusCode = 200
      res.json({ put : "buffer" })
    }))
  })

  server.expect("PUT", "/body-string", function (req, res) {
    req.pipe(concat(function (d) {
      t.equal(d.toString("utf8"), "erp", "streamed expected data")

      res.statusCode = 200
      res.json({ put : "string" })
    }))
  })

  server.expect("PUT", "/body-object", function (req, res) {
    req.pipe(concat(function (d) {
      t.equal(d.toString("utf8"), '["tricky"]', "streamed expected data")

      res.statusCode = 200
      res.json({ put : "object" })
    }))
  })

  var defaults = {}
  client.request(common.registry+"/request-defaults", defaults, function (er, data) {
    t.ifError(er, "call worked")
    t.deepEquals(data, { fetched : "defaults" }, "confirmed defaults work")
  })

  var etagged = { etag : "test-etag" }
  client.request(common.registry+"/etag", etagged, function (er, data) {
    t.ifError(er, "call worked")
    t.deepEquals(data, { fetched : "etag" }, "etag request sent")
  })

  var postEtagged = {
    method : "post",
    etag   : "post-etag"
  }
  client.request(common.registry+"/etag-post", postEtagged, function (er, data) {
    t.ifError(er, "call worked")
    t.deepEquals(data, { posted : "etag" }, "POST etag request sent")
  })

  var putStream = {
    method : "PUT",
    body : new OneA(),
    auth : AUTH
  }
  client.request(common.registry+"/body-stream", putStream, function (er, data) {
    t.ifError(er, "call worked")
    t.deepEquals(data, { put : "stream" }, "PUT request with stream sent")
  })

  var putBuffer = {
    method : "PUT",
    body : new Buffer("hi"),
    auth : AUTH
  }
  client.request(common.registry+"/body-buffer", putBuffer, function (er, data) {
    t.ifError(er, "call worked")
    t.deepEquals(data, { put : "buffer" }, "PUT request with buffer sent")
  })

  var putString = {
    method : "PUT",
    body : "erp",
    auth : AUTH
  }
  client.request(common.registry+"/body-string", putString, function (er, data) {
    t.ifError(er, "call worked")
    t.deepEquals(data, { put : "string" }, "PUT request with string sent")
  })

  var putObject = {
    method : "PUT",
    body : { toJSON : function () { return [ "tricky" ] } },
    auth : AUTH
  }
  client.request(common.registry+"/body-object", putObject, function (er, data) {
    t.ifError(er, "call worked")
    t.deepEquals(data, { put : "object" }, "PUT request with object sent")
  })
})
