import {createRequire as __cr} from 'module'; const require = __cr(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "../../node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// ../../node_modules/node-gyp-build/node-gyp-build.js
var require_node_gyp_build = __commonJS({
  "../../node_modules/node-gyp-build/node-gyp-build.js"(exports, module) {
    var fs = __require("fs");
    var path = __require("path");
    var os = __require("os");
    var runtimeRequire = typeof __webpack_require__ === "function" ? __non_webpack_require__ : __require;
    var vars = process.config && process.config.variables || {};
    var prebuildsOnly = !!process.env.PREBUILDS_ONLY;
    var abi = process.versions.modules;
    var runtime = isElectron() ? "electron" : isNwjs() ? "node-webkit" : "node";
    var arch = process.env.npm_config_arch || os.arch();
    var platform3 = process.env.npm_config_platform || os.platform();
    var libc = process.env.LIBC || (isAlpine(platform3) ? "musl" : "glibc");
    var armv = process.env.ARM_VERSION || (arch === "arm64" ? "8" : vars.arm_version) || "";
    var uv = (process.versions.uv || "").split(".")[0];
    module.exports = load;
    function load(dir) {
      return runtimeRequire(load.resolve(dir));
    }
    load.resolve = load.path = function(dir) {
      dir = path.resolve(dir || ".");
      try {
        var name = runtimeRequire(path.join(dir, "package.json")).name.toUpperCase().replace(/-/g, "_");
        if (process.env[name + "_PREBUILD"]) dir = process.env[name + "_PREBUILD"];
      } catch (err) {
      }
      if (!prebuildsOnly) {
        var release = getFirst(path.join(dir, "build/Release"), matchBuild);
        if (release) return release;
        var debug = getFirst(path.join(dir, "build/Debug"), matchBuild);
        if (debug) return debug;
      }
      var prebuild = resolve4(dir);
      if (prebuild) return prebuild;
      var nearby = resolve4(path.dirname(process.execPath));
      if (nearby) return nearby;
      var target = [
        "platform=" + platform3,
        "arch=" + arch,
        "runtime=" + runtime,
        "abi=" + abi,
        "uv=" + uv,
        armv ? "armv=" + armv : "",
        "libc=" + libc,
        "node=" + process.versions.node,
        process.versions.electron ? "electron=" + process.versions.electron : "",
        typeof __webpack_require__ === "function" ? "webpack=true" : ""
        // eslint-disable-line
      ].filter(Boolean).join(" ");
      throw new Error("No native build was found for " + target + "\n    loaded from: " + dir + "\n");
      function resolve4(dir2) {
        var tuples = readdirSync2(path.join(dir2, "prebuilds")).map(parseTuple);
        var tuple = tuples.filter(matchTuple(platform3, arch)).sort(compareTuples)[0];
        if (!tuple) return;
        var prebuilds = path.join(dir2, "prebuilds", tuple.name);
        var parsed = readdirSync2(prebuilds).map(parseTags);
        var candidates = parsed.filter(matchTags(runtime, abi));
        var winner = candidates.sort(compareTags(runtime))[0];
        if (winner) return path.join(prebuilds, winner.file);
      }
    };
    function readdirSync2(dir) {
      try {
        return fs.readdirSync(dir);
      } catch (err) {
        return [];
      }
    }
    function getFirst(dir, filter) {
      var files = readdirSync2(dir).filter(filter);
      return files[0] && path.join(dir, files[0]);
    }
    function matchBuild(name) {
      return /\.node$/.test(name);
    }
    function parseTuple(name) {
      var arr = name.split("-");
      if (arr.length !== 2) return;
      var platform4 = arr[0];
      var architectures = arr[1].split("+");
      if (!platform4) return;
      if (!architectures.length) return;
      if (!architectures.every(Boolean)) return;
      return { name, platform: platform4, architectures };
    }
    function matchTuple(platform4, arch2) {
      return function(tuple) {
        if (tuple == null) return false;
        if (tuple.platform !== platform4) return false;
        return tuple.architectures.includes(arch2);
      };
    }
    function compareTuples(a, b) {
      return a.architectures.length - b.architectures.length;
    }
    function parseTags(file) {
      var arr = file.split(".");
      var extension2 = arr.pop();
      var tags = { file, specificity: 0 };
      if (extension2 !== "node") return;
      for (var i = 0; i < arr.length; i++) {
        var tag = arr[i];
        if (tag === "node" || tag === "electron" || tag === "node-webkit") {
          tags.runtime = tag;
        } else if (tag === "napi") {
          tags.napi = true;
        } else if (tag.slice(0, 3) === "abi") {
          tags.abi = tag.slice(3);
        } else if (tag.slice(0, 2) === "uv") {
          tags.uv = tag.slice(2);
        } else if (tag.slice(0, 4) === "armv") {
          tags.armv = tag.slice(4);
        } else if (tag === "glibc" || tag === "musl") {
          tags.libc = tag;
        } else {
          continue;
        }
        tags.specificity++;
      }
      return tags;
    }
    function matchTags(runtime2, abi2) {
      return function(tags) {
        if (tags == null) return false;
        if (tags.runtime && tags.runtime !== runtime2 && !runtimeAgnostic(tags)) return false;
        if (tags.abi && tags.abi !== abi2 && !tags.napi) return false;
        if (tags.uv && tags.uv !== uv) return false;
        if (tags.armv && tags.armv !== armv) return false;
        if (tags.libc && tags.libc !== libc) return false;
        return true;
      };
    }
    function runtimeAgnostic(tags) {
      return tags.runtime === "node" && tags.napi;
    }
    function compareTags(runtime2) {
      return function(a, b) {
        if (a.runtime !== b.runtime) {
          return a.runtime === runtime2 ? -1 : 1;
        } else if (a.abi !== b.abi) {
          return a.abi ? -1 : 1;
        } else if (a.specificity !== b.specificity) {
          return a.specificity > b.specificity ? -1 : 1;
        } else {
          return 0;
        }
      };
    }
    function isNwjs() {
      return !!(process.versions && process.versions.nw);
    }
    function isElectron() {
      if (process.versions && process.versions.electron) return true;
      if (process.env.ELECTRON_RUN_AS_NODE) return true;
      return typeof window !== "undefined" && window.process && window.process.type === "renderer";
    }
    function isAlpine(platform4) {
      return platform4 === "linux" && fs.existsSync("/etc/alpine-release");
    }
    load.parseTags = parseTags;
    load.matchTags = matchTags;
    load.compareTags = compareTags;
    load.parseTuple = parseTuple;
    load.matchTuple = matchTuple;
    load.compareTuples = compareTuples;
  }
});

// ../../node_modules/node-gyp-build/index.js
var require_node_gyp_build2 = __commonJS({
  "../../node_modules/node-gyp-build/index.js"(exports, module) {
    var runtimeRequire = typeof __webpack_require__ === "function" ? __non_webpack_require__ : __require;
    if (typeof runtimeRequire.addon === "function") {
      module.exports = runtimeRequire.addon.bind(runtimeRequire);
    } else {
      module.exports = require_node_gyp_build();
    }
  }
});

// ../../node_modules/bufferutil/fallback.js
var require_fallback = __commonJS({
  "../../node_modules/bufferutil/fallback.js"(exports, module) {
    "use strict";
    var mask = (source, mask2, output, offset, length) => {
      for (var i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask2[i & 3];
      }
    };
    var unmask = (buffer, mask2) => {
      const length = buffer.length;
      for (var i = 0; i < length; i++) {
        buffer[i] ^= mask2[i & 3];
      }
    };
    module.exports = { mask, unmask };
  }
});

// ../../node_modules/bufferutil/index.js
var require_bufferutil = __commonJS({
  "../../node_modules/bufferutil/index.js"(exports, module) {
    "use strict";
    try {
      module.exports = require_node_gyp_build2()(__dirname);
    } catch (e) {
      module.exports = require_fallback();
    }
  }
});

// ../../node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "../../node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require_bufferutil();
        module.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "../../node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// ../../node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "../../node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// ../../node_modules/utf-8-validate/fallback.js
var require_fallback2 = __commonJS({
  "../../node_modules/utf-8-validate/fallback.js"(exports, module) {
    "use strict";
    function isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    module.exports = isValidUTF8;
  }
});

// ../../node_modules/utf-8-validate/index.js
var require_utf_8_validate = __commonJS({
  "../../node_modules/utf-8-validate/index.js"(exports, module) {
    "use strict";
    try {
      module.exports = require_node_gyp_build2()(__dirname);
    } catch (e) {
      module.exports = require_fallback2();
    }
  }
});

// ../../node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "../../node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require_utf_8_validate();
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "../../node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
            const error = this.createError(
              RangeError,
              "Too many message fragments",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            );
            cb(error);
            return;
          }
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
              const error = this.createError(
                RangeError,
                "Too many message fragments",
                false,
                1008,
                "WS_ERR_TOO_MANY_BUFFERED_PARTS"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// ../../node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "../../node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var {
      types: { isUint8Array }
    } = __require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT2 = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT2;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT2) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT2) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT2) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT2) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT2) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT2) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT2) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT2;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT2;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT2 && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// ../../node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "../../node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event2 = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event2.prototype, "target", { enumerable: true });
    Object.defineProperty(Event2.prototype, "type", { enumerable: true });
    var CloseEvent2 = class extends Event2 {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent2.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent2.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent2.prototype, "wasClean", { enumerable: true });
    var ErrorEvent2 = class extends Event2 {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent2.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent2.prototype, "message", { enumerable: true });
    var MessageEvent2 = class extends Event2 {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent2.prototype, "data", { enumerable: true });
    var EventTarget2 = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent2("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent2("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent2("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event2("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent: CloseEvent2,
      ErrorEvent: ErrorEvent2,
      Event: Event2,
      EventTarget: EventTarget2,
      MessageEvent: MessageEvent2
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// ../../node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "../../node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});

// ../../node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "../../node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net = __require("net");
    var tls = __require("tls");
    var { randomBytes, createHash: createHash2 } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL: URL2 } = __require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket3 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket3, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket3.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket3, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket3.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket3, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket3.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket3, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket3.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket3.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket3.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket3.prototype.addEventListener = addEventListener;
    WebSocket3.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket3;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 1024 * 1024,
        maxFragments: 128 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket3.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket3.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket3.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket3.CLOSED) return;
      if (websocket.readyState === WebSocket3.OPEN) {
        websocket._readyState = WebSocket3.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket3.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket3.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket3.CLOSING;
        this.destroy();
      }
    }
  }
});

// ../../node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "../../node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket3 = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open2() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open2() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// ../../node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "../../node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});

// ../../node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "../../node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http = __require("http");
    var { Duplex } = __require("stream");
    var { createHash: createHash2 } = __require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket3 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=1048576] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=131072] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 1024 * 1024,
          maxFragments: 128 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket3,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// bin/spellguard-credential-daemon.ts
import { execFileSync as execFileSync6, execSync } from "node:child_process";
import { randomUUID as randomUUID3 } from "node:crypto";
import {
  appendFileSync as appendFileSync3,
  chmodSync as chmodSync6,
  closeSync as closeSync4,
  existsSync as existsSync8,
  mkdirSync as mkdirSync7,
  openSync as openSync4,
  readFileSync as readFileSync5,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync6,
  writeSync as writeSync2
} from "node:fs";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname6, join as join10 } from "node:path";

// ../agent-control/dist/index.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ../../node_modules/partysocket/dist/ws.js
if (!globalThis.EventTarget || !globalThis.Event)
  console.error(`
  PartySocket requires a global 'EventTarget' class to be available!
  You can polyfill this global by adding this to your code before any partysocket imports: 
  
  \`\`\`
  import 'partysocket/event-target-polyfill';
  \`\`\`
  Please file an issue at https://github.com/partykit/partykit if you're still having trouble.
`);
var ErrorEvent = class extends Event {
  message;
  error;
  constructor(error, target) {
    super("error", target);
    this.message = error.message;
    this.error = error;
  }
};
var CloseEvent = class extends Event {
  code;
  reason;
  wasClean = true;
  constructor(code = 1e3, reason = "", target) {
    super("close", target);
    this.code = code;
    this.reason = reason;
  }
};
var Events = {
  Event,
  ErrorEvent,
  CloseEvent
};
function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}
function cloneEventBrowser(e) {
  return new e.constructor(e.type, e);
}
function cloneEventNode(e) {
  if ("data" in e) return new MessageEvent(e.type, e);
  if ("code" in e || "reason" in e)
    return new CloseEvent(e.code || 1999, e.reason || "unknown reason", e);
  if ("error" in e) return new ErrorEvent(e.error, e);
  return new Event(e.type, e);
}
var isNode = typeof process !== "undefined" && typeof process.versions?.node !== "undefined";
var isReactNative = typeof navigator !== "undefined" && navigator.product === "ReactNative";
var cloneEvent = isNode || isReactNative ? cloneEventNode : cloneEventBrowser;
var DEFAULT = {
  maxReconnectionDelay: 1e4,
  minReconnectionDelay: 1e3 + Math.random() * 4e3,
  minUptime: 5e3,
  reconnectionDelayGrowFactor: 1.3,
  connectionTimeout: 4e3,
  maxRetries: Number.POSITIVE_INFINITY,
  maxEnqueuedMessages: Number.POSITIVE_INFINITY,
  startClosed: false,
  debug: false
};
var didWarnAboutMissingWebSocket = false;
var ReconnectingWebSocket = class ReconnectingWebSocket2 extends EventTarget {
  _ws;
  _retryCount = -1;
  _uptimeTimeout;
  _connectTimeout;
  _shouldReconnect = true;
  _connectLock = false;
  _binaryType = "blob";
  _closeCalled = false;
  _messageQueue = [];
  _debugLogger = console.log.bind(console);
  _url;
  _protocols;
  _options;
  constructor(url, protocols, options = {}) {
    super();
    this._url = url;
    this._protocols = protocols;
    this._options = options;
    if (this._options.startClosed) this._shouldReconnect = false;
    if (this._options.debugLogger)
      this._debugLogger = this._options.debugLogger;
    this._connect();
  }
  static get CONNECTING() {
    return 0;
  }
  static get OPEN() {
    return 1;
  }
  static get CLOSING() {
    return 2;
  }
  static get CLOSED() {
    return 3;
  }
  get CONNECTING() {
    return ReconnectingWebSocket2.CONNECTING;
  }
  get OPEN() {
    return ReconnectingWebSocket2.OPEN;
  }
  get CLOSING() {
    return ReconnectingWebSocket2.CLOSING;
  }
  get CLOSED() {
    return ReconnectingWebSocket2.CLOSED;
  }
  get binaryType() {
    return this._ws ? this._ws.binaryType : this._binaryType;
  }
  set binaryType(value) {
    this._binaryType = value;
    if (this._ws) this._ws.binaryType = value;
  }
  /**
   * Returns the number or connection retries
   */
  get retryCount() {
    return Math.max(this._retryCount, 0);
  }
  /**
   * The number of bytes of data that have been queued using calls to send() but not yet
   * transmitted to the network. This value resets to zero once all queued data has been sent.
   * This value does not reset to zero when the connection is closed; if you keep calling send(),
   * this will continue to climb. Read only
   */
  get bufferedAmount() {
    return this._messageQueue.reduce((acc, message) => {
      if (typeof message === "string") acc += message.length;
      else if (message instanceof Blob) acc += message.size;
      else acc += message.byteLength;
      return acc;
    }, 0) + (this._ws ? this._ws.bufferedAmount : 0);
  }
  /**
   * The extensions selected by the server. This is currently only the empty string or a list of
   * extensions as negotiated by the connection
   */
  get extensions() {
    return this._ws ? this._ws.extensions : "";
  }
  /**
   * A string indicating the name of the sub-protocol the server selected;
   * this will be one of the strings specified in the protocols parameter when creating the
   * WebSocket object
   */
  get protocol() {
    return this._ws ? this._ws.protocol : "";
  }
  /**
   * The current state of the connection; this is one of the Ready state constants
   */
  get readyState() {
    if (this._ws) return this._ws.readyState;
    return this._options.startClosed ? ReconnectingWebSocket2.CLOSED : ReconnectingWebSocket2.CONNECTING;
  }
  /**
   * The URL as resolved by the constructor
   */
  get url() {
    return this._ws ? this._ws.url : "";
  }
  /**
   * Whether the websocket object is now in reconnectable state
   */
  get shouldReconnect() {
    return this._shouldReconnect;
  }
  /**
   * An event listener to be called when the WebSocket connection's readyState changes to CLOSED
   */
  onclose = null;
  /**
   * An event listener to be called when an error occurs
   */
  onerror = null;
  /**
   * An event listener to be called when a message is received from the server
   */
  onmessage = null;
  /**
   * An event listener to be called when the WebSocket connection's readyState changes to OPEN;
   * this indicates that the connection is ready to send and receive data
   */
  onopen = null;
  /**
   * Closes the WebSocket connection or connection attempt, if any. If the connection is already
   * CLOSED, this method does nothing
   */
  close(code = 1e3, reason) {
    this._closeCalled = true;
    this._shouldReconnect = false;
    this._clearTimeouts();
    if (!this._ws) {
      this._debug("close enqueued: no ws instance");
      return;
    }
    if (this._ws.readyState === this.CLOSED) {
      this._debug("close: already closed");
      return;
    }
    this._ws.close(code, reason);
  }
  /**
   * Closes the WebSocket connection or connection attempt and connects again.
   * Resets retry counter;
   */
  reconnect(code, reason) {
    this._shouldReconnect = true;
    this._closeCalled = false;
    this._retryCount = -1;
    if (!this._ws || this._ws.readyState === this.CLOSED) this._connect();
    else {
      this._disconnect(code, reason);
      this._connect();
    }
  }
  /**
   * Enqueue specified data to be transmitted to the server over the WebSocket connection
   */
  send(data) {
    if (this._ws && this._ws.readyState === this.OPEN) {
      this._debug("send", data);
      this._ws.send(data);
    } else {
      const { maxEnqueuedMessages = DEFAULT.maxEnqueuedMessages } = this._options;
      if (this._messageQueue.length < maxEnqueuedMessages) {
        this._debug("enqueue", data);
        this._messageQueue.push(data);
      }
    }
  }
  _debug(...args) {
    if (this._options.debug) this._debugLogger("RWS>", ...args);
  }
  _getNextDelay() {
    const {
      reconnectionDelayGrowFactor = DEFAULT.reconnectionDelayGrowFactor,
      minReconnectionDelay = DEFAULT.minReconnectionDelay,
      maxReconnectionDelay = DEFAULT.maxReconnectionDelay
    } = this._options;
    let delay = 0;
    if (this._retryCount > 0) {
      delay = minReconnectionDelay * reconnectionDelayGrowFactor ** (this._retryCount - 1);
      if (delay > maxReconnectionDelay) delay = maxReconnectionDelay;
    }
    this._debug("next delay", delay);
    return delay;
  }
  _wait() {
    return new Promise((resolve4) => {
      setTimeout(resolve4, this._getNextDelay());
    });
  }
  _getNextProtocols(protocolsProvider) {
    if (!protocolsProvider) return Promise.resolve(null);
    if (typeof protocolsProvider === "string" || Array.isArray(protocolsProvider))
      return Promise.resolve(protocolsProvider);
    if (typeof protocolsProvider === "function") {
      const protocols = protocolsProvider();
      if (!protocols) return Promise.resolve(null);
      if (typeof protocols === "string" || Array.isArray(protocols))
        return Promise.resolve(protocols);
      if (protocols.then) return protocols;
    }
    throw Error("Invalid protocols");
  }
  _getNextUrl(urlProvider) {
    if (typeof urlProvider === "string") return Promise.resolve(urlProvider);
    if (typeof urlProvider === "function") {
      const url = urlProvider();
      if (typeof url === "string") return Promise.resolve(url);
      if (url.then) return url;
    }
    throw Error("Invalid URL");
  }
  _connect() {
    if (this._connectLock || !this._shouldReconnect) return;
    this._connectLock = true;
    const {
      maxRetries = DEFAULT.maxRetries,
      connectionTimeout = DEFAULT.connectionTimeout
    } = this._options;
    if (this._retryCount >= maxRetries) {
      this._debug("max retries reached", this._retryCount, ">=", maxRetries);
      this._connectLock = false;
      return;
    }
    this._retryCount++;
    this._debug("connect", this._retryCount);
    this._removeListeners();
    this._wait().then(
      () => Promise.all([
        this._getNextUrl(this._url),
        this._getNextProtocols(this._protocols || null)
      ])
    ).then(([url, protocols]) => {
      if (this._closeCalled) {
        this._connectLock = false;
        return;
      }
      if (!this._options.WebSocket && typeof WebSocket === "undefined" && !didWarnAboutMissingWebSocket) {
        console.error(`\u203C\uFE0F No WebSocket implementation available. You should define options.WebSocket. 

For example, if you're using node.js, run \`npm install ws\`, and then in your code:

import PartySocket from 'partysocket';
import WS from 'ws';

const partysocket = new PartySocket({
  host: "127.0.0.1:1999",
  room: "test-room",
  WebSocket: WS
});

`);
        didWarnAboutMissingWebSocket = true;
      }
      const WS = this._options.WebSocket || WebSocket;
      this._debug("connect", {
        url,
        protocols
      });
      this._ws = protocols ? new WS(url, protocols) : new WS(url);
      this._ws.binaryType = this._binaryType;
      this._connectLock = false;
      this._addListeners();
      this._connectTimeout = setTimeout(
        () => this._handleTimeout(),
        connectionTimeout
      );
    }).catch((err) => {
      this._connectLock = false;
      this._handleError(new Events.ErrorEvent(Error(err.message), this));
    });
  }
  _handleTimeout() {
    this._debug("timeout event");
    this._handleError(new Events.ErrorEvent(Error("TIMEOUT"), this));
  }
  _disconnect(code = 1e3, reason) {
    this._clearTimeouts();
    if (!this._ws) return;
    this._removeListeners();
    try {
      if (this._ws.readyState === this.OPEN || this._ws.readyState === this.CONNECTING)
        this._ws.close(code, reason);
      this._handleClose(new Events.CloseEvent(code, reason, this));
    } catch (_error) {
    }
  }
  _acceptOpen() {
    this._debug("accept open");
    this._retryCount = 0;
  }
  _handleOpen = (event) => {
    this._debug("open event");
    const { minUptime = DEFAULT.minUptime } = this._options;
    clearTimeout(this._connectTimeout);
    this._uptimeTimeout = setTimeout(() => this._acceptOpen(), minUptime);
    assert(this._ws, "WebSocket is not defined");
    this._ws.binaryType = this._binaryType;
    this._messageQueue.forEach((message) => {
      this._ws?.send(message);
    });
    this._messageQueue = [];
    if (this.onopen) this.onopen(event);
    this.dispatchEvent(cloneEvent(event));
  };
  _handleMessage = (event) => {
    this._debug("message event");
    if (this.onmessage) this.onmessage(event);
    this.dispatchEvent(cloneEvent(event));
  };
  _handleError = (event) => {
    this._debug("error event", event.message);
    this._disconnect(void 0, event.message === "TIMEOUT" ? "timeout" : void 0);
    if (this.onerror) this.onerror(event);
    this._debug("exec error listeners");
    this.dispatchEvent(cloneEvent(event));
    this._connect();
  };
  _handleClose = (event) => {
    this._debug("close event");
    this._clearTimeouts();
    if (this._shouldReconnect) this._connect();
    if (this.onclose) this.onclose(event);
    this.dispatchEvent(cloneEvent(event));
  };
  _removeListeners() {
    if (!this._ws) return;
    this._debug("removeListeners");
    this._ws.removeEventListener("open", this._handleOpen);
    this._ws.removeEventListener("close", this._handleClose);
    this._ws.removeEventListener("message", this._handleMessage);
    this._ws.removeEventListener("error", this._handleError);
  }
  _addListeners() {
    if (!this._ws) return;
    this._debug("addListeners");
    this._ws.addEventListener("open", this._handleOpen);
    this._ws.addEventListener("close", this._handleClose);
    this._ws.addEventListener("message", this._handleMessage);
    this._ws.addEventListener("error", this._handleError);
  }
  _clearTimeouts() {
    clearTimeout(this._connectTimeout);
    clearTimeout(this._uptimeTimeout);
  }
};

// ../../node_modules/partysocket/dist/index.js
var valueIsNotNil = (keyValuePair) => keyValuePair[1] !== null && keyValuePair[1] !== void 0;
function generateUUID() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  let d = Date.now();
  let d2 = performance?.now && performance.now() * 1e3 || 0;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    let r = Math.random() * 16;
    if (d > 0) {
      r = (d + r) % 16 | 0;
      d = Math.floor(d / 16);
    } else {
      r = (d2 + r) % 16 | 0;
      d2 = Math.floor(d2 / 16);
    }
    return (c === "x" ? r : r & 3 | 8).toString(16);
  });
}
function getPartyInfo(partySocketOptions, defaultProtocol, defaultParams = {}) {
  const {
    host: rawHost,
    path: rawPath,
    protocol: rawProtocol,
    room,
    party,
    basePath,
    prefix,
    query
  } = partySocketOptions;
  let host = rawHost.replace(/^(http|https|ws|wss):\/\//, "");
  if (host.endsWith("/")) host = host.slice(0, -1);
  if (rawPath?.startsWith("/"))
    throw new Error("path must not start with a slash");
  const name = party ?? "main";
  const path = rawPath ? `/${rawPath}` : "";
  const protocol = rawProtocol || (host.startsWith("localhost:") || host.startsWith("127.0.0.1:") || host.startsWith("192.168.") || host.startsWith("10.") || host.startsWith("172.") && host.split(".")[1] >= "16" && host.split(".")[1] <= "31" || host.startsWith("[::ffff:7f00:1]:") ? defaultProtocol : `${defaultProtocol}s`);
  const baseUrl = `${protocol}://${host}/${basePath || `${prefix || "parties"}/${name}/${room}`}${path}`;
  const makeUrl = (query2 = {}) => `${baseUrl}?${new URLSearchParams([...Object.entries(defaultParams), ...Object.entries(query2).filter(valueIsNotNil)])}`;
  const urlProvider = typeof query === "function" ? async () => makeUrl(await query()) : makeUrl(query);
  return {
    host,
    path,
    room,
    name,
    protocol,
    partyUrl: baseUrl,
    urlProvider
  };
}
var PartySocket = class extends ReconnectingWebSocket {
  _pk;
  _pkurl;
  name;
  room;
  host;
  path;
  basePath;
  constructor(partySocketOptions) {
    const wsOptions = getWSOptions(partySocketOptions);
    super(wsOptions.urlProvider, wsOptions.protocols, wsOptions.socketOptions);
    this.partySocketOptions = partySocketOptions;
    this.setWSProperties(wsOptions);
    if (!partySocketOptions.startClosed && !this.room && !this.basePath) {
      this.close();
      throw new Error(
        "Either room or basePath must be provided to connect. Use startClosed: true to create a socket and set them via updateProperties before calling reconnect()."
      );
    }
    if (!partySocketOptions.disableNameValidation) {
      if (partySocketOptions.party?.includes("/"))
        console.warn(
          `PartySocket: party name "${partySocketOptions.party}" contains forward slash which may cause routing issues. Consider using a name without forward slashes or set disableNameValidation: true to bypass this warning.`
        );
      if (partySocketOptions.room?.includes("/"))
        console.warn(
          `PartySocket: room name "${partySocketOptions.room}" contains forward slash which may cause routing issues. Consider using a name without forward slashes or set disableNameValidation: true to bypass this warning.`
        );
    }
  }
  updateProperties(partySocketOptions) {
    const wsOptions = getWSOptions({
      ...this.partySocketOptions,
      ...partySocketOptions,
      host: partySocketOptions.host ?? this.host,
      room: partySocketOptions.room ?? this.room,
      path: partySocketOptions.path ?? this.path,
      basePath: partySocketOptions.basePath ?? this.basePath
    });
    this._url = wsOptions.urlProvider;
    this._protocols = wsOptions.protocols;
    this._options = wsOptions.socketOptions;
    this.setWSProperties(wsOptions);
  }
  setWSProperties(wsOptions) {
    const { _pk, _pkurl, name, room, host, path, basePath } = wsOptions;
    this._pk = _pk;
    this._pkurl = _pkurl;
    this.name = name;
    this.room = room;
    this.host = host;
    this.path = path;
    this.basePath = basePath;
  }
  reconnect(code, reason) {
    if (!this.host)
      throw new Error(
        "The host must be set before connecting, use `updateProperties` method to set it or pass it to the constructor."
      );
    if (!this.room && !this.basePath)
      throw new Error(
        "The room (or basePath) must be set before connecting, use `updateProperties` method to set it or pass it to the constructor."
      );
    super.reconnect(code, reason);
  }
  get id() {
    return this._pk;
  }
  /**
   * Exposes the static PartyKit room URL without applying query parameters.
   * To access the currently connected WebSocket url, use PartySocket#url.
   */
  get roomUrl() {
    return this._pkurl;
  }
  static async fetch(options, init) {
    const party = getPartyInfo(options, "http");
    const url = typeof party.urlProvider === "string" ? party.urlProvider : await party.urlProvider();
    return (options.fetch ?? fetch)(url, init);
  }
};
function getWSOptions(partySocketOptions) {
  const {
    id,
    host: _host,
    path: _path,
    party: _party,
    room: _room,
    protocol: _protocol,
    query: _query,
    protocols,
    ...socketOptions
  } = partySocketOptions;
  const _pk = id || generateUUID();
  const party = getPartyInfo(partySocketOptions, "ws", { _pk });
  return {
    _pk,
    _pkurl: party.partyUrl,
    name: party.name,
    room: party.room,
    host: party.host,
    path: party.path,
    basePath: partySocketOptions.basePath,
    protocols,
    socketOptions,
    urlProvider: party.urlProvider
  };
}

// ../../node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;

// ../../node_modules/openapi-fetch/dist/index.mjs
var PATH_PARAM_RE = /\{[^{}]+\}/g;
var supportsRequestInitExt = () => {
  return typeof process === "object" && Number.parseInt(process?.versions?.node?.substring(0, 2)) >= 18 && process.versions.undici;
};
function randomID() {
  return Math.random().toString(36).slice(2, 11);
}
function createClient(clientOptions) {
  let {
    baseUrl = "",
    Request: CustomRequest = globalThis.Request,
    fetch: baseFetch = globalThis.fetch,
    querySerializer: globalQuerySerializer,
    bodySerializer: globalBodySerializer,
    pathSerializer: globalPathSerializer,
    headers: baseHeaders,
    requestInitExt = void 0,
    ...baseOptions
  } = { ...clientOptions };
  requestInitExt = supportsRequestInitExt() ? requestInitExt : void 0;
  baseUrl = removeTrailingSlash(baseUrl);
  const globalMiddlewares = [];
  async function coreFetch(schemaPath, fetchOptions) {
    const {
      baseUrl: localBaseUrl,
      fetch: fetch2 = baseFetch,
      Request: Request2 = CustomRequest,
      headers,
      params = {},
      parseAs = "json",
      querySerializer: requestQuerySerializer,
      bodySerializer = globalBodySerializer ?? defaultBodySerializer,
      pathSerializer: requestPathSerializer,
      body,
      middleware: requestMiddlewares = [],
      ...init
    } = fetchOptions || {};
    let finalBaseUrl = baseUrl;
    if (localBaseUrl) {
      finalBaseUrl = removeTrailingSlash(localBaseUrl) ?? baseUrl;
    }
    let querySerializer = typeof globalQuerySerializer === "function" ? globalQuerySerializer : createQuerySerializer(globalQuerySerializer);
    if (requestQuerySerializer) {
      querySerializer = typeof requestQuerySerializer === "function" ? requestQuerySerializer : createQuerySerializer({
        ...typeof globalQuerySerializer === "object" ? globalQuerySerializer : {},
        ...requestQuerySerializer
      });
    }
    const pathSerializer = requestPathSerializer || globalPathSerializer || defaultPathSerializer;
    const serializedBody = body === void 0 ? void 0 : bodySerializer(
      body,
      // Note: we declare mergeHeaders() both here and below because it’s a bit of a chicken-or-egg situation:
      // bodySerializer() needs all headers so we aren’t dropping ones set by the user, however,
      // the result of this ALSO sets the lowest-priority content-type header. So we re-merge below,
      // setting the content-type at the very beginning to be overwritten.
      // Lastly, based on the way headers work, it’s not a simple “present-or-not” check becauase null intentionally un-sets headers.
      mergeHeaders(baseHeaders, headers, params.header)
    );
    const finalHeaders = mergeHeaders(
      // with no body, we should not to set Content-Type
      serializedBody === void 0 || // if serialized body is FormData; browser will correctly set Content-Type & boundary expression
      serializedBody instanceof FormData ? {} : {
        "Content-Type": "application/json"
      },
      baseHeaders,
      headers,
      params.header
    );
    const finalMiddlewares = [...globalMiddlewares, ...requestMiddlewares];
    const requestInit = {
      redirect: "follow",
      ...baseOptions,
      ...init,
      body: serializedBody,
      headers: finalHeaders
    };
    let id;
    let options;
    let request = new Request2(
      createFinalURL(schemaPath, { baseUrl: finalBaseUrl, params, querySerializer, pathSerializer }),
      requestInit
    );
    let response;
    for (const key in init) {
      if (!(key in request)) {
        request[key] = init[key];
      }
    }
    if (finalMiddlewares.length) {
      id = randomID();
      options = Object.freeze({
        baseUrl: finalBaseUrl,
        fetch: fetch2,
        parseAs,
        querySerializer,
        bodySerializer,
        pathSerializer
      });
      for (const m of finalMiddlewares) {
        if (m && typeof m === "object" && typeof m.onRequest === "function") {
          const result = await m.onRequest({
            request,
            schemaPath,
            params,
            options,
            id
          });
          if (result) {
            if (result instanceof Request2) {
              request = result;
            } else if (result instanceof Response) {
              response = result;
              break;
            } else {
              throw new Error("onRequest: must return new Request() or Response() when modifying the request");
            }
          }
        }
      }
    }
    if (!response) {
      try {
        response = await fetch2(request, requestInitExt);
      } catch (error2) {
        let errorAfterMiddleware = error2;
        if (finalMiddlewares.length) {
          for (let i = finalMiddlewares.length - 1; i >= 0; i--) {
            const m = finalMiddlewares[i];
            if (m && typeof m === "object" && typeof m.onError === "function") {
              const result = await m.onError({
                request,
                error: errorAfterMiddleware,
                schemaPath,
                params,
                options,
                id
              });
              if (result) {
                if (result instanceof Response) {
                  errorAfterMiddleware = void 0;
                  response = result;
                  break;
                }
                if (result instanceof Error) {
                  errorAfterMiddleware = result;
                  continue;
                }
                throw new Error("onError: must return new Response() or instance of Error");
              }
            }
          }
        }
        if (errorAfterMiddleware) {
          throw errorAfterMiddleware;
        }
      }
      if (finalMiddlewares.length) {
        for (let i = finalMiddlewares.length - 1; i >= 0; i--) {
          const m = finalMiddlewares[i];
          if (m && typeof m === "object" && typeof m.onResponse === "function") {
            const result = await m.onResponse({
              request,
              response,
              schemaPath,
              params,
              options,
              id
            });
            if (result) {
              if (!(result instanceof Response)) {
                throw new Error("onResponse: must return new Response() when modifying the response");
              }
              response = result;
            }
          }
        }
      }
    }
    const contentLength = response.headers.get("Content-Length");
    if (response.status === 204 || request.method === "HEAD" || contentLength === "0" && !response.headers.get("Transfer-Encoding")?.includes("chunked")) {
      return response.ok ? { data: void 0, response } : { error: void 0, response };
    }
    if (response.ok) {
      const getResponseData = async () => {
        if (parseAs === "stream") {
          return response.body;
        }
        if (parseAs === "json" && !contentLength) {
          const raw = await response.text();
          return raw ? JSON.parse(raw) : void 0;
        }
        return await response[parseAs]();
      };
      return { data: await getResponseData(), response };
    }
    let error = await response.text();
    try {
      error = JSON.parse(error);
    } catch {
    }
    return { error, response };
  }
  return {
    request(method, url, init) {
      return coreFetch(url, { ...init, method: method.toUpperCase() });
    },
    /** Call a GET endpoint */
    GET(url, init) {
      return coreFetch(url, { ...init, method: "GET" });
    },
    /** Call a PUT endpoint */
    PUT(url, init) {
      return coreFetch(url, { ...init, method: "PUT" });
    },
    /** Call a POST endpoint */
    POST(url, init) {
      return coreFetch(url, { ...init, method: "POST" });
    },
    /** Call a DELETE endpoint */
    DELETE(url, init) {
      return coreFetch(url, { ...init, method: "DELETE" });
    },
    /** Call a OPTIONS endpoint */
    OPTIONS(url, init) {
      return coreFetch(url, { ...init, method: "OPTIONS" });
    },
    /** Call a HEAD endpoint */
    HEAD(url, init) {
      return coreFetch(url, { ...init, method: "HEAD" });
    },
    /** Call a PATCH endpoint */
    PATCH(url, init) {
      return coreFetch(url, { ...init, method: "PATCH" });
    },
    /** Call a TRACE endpoint */
    TRACE(url, init) {
      return coreFetch(url, { ...init, method: "TRACE" });
    },
    /** Register middleware */
    use(...middleware) {
      for (const m of middleware) {
        if (!m) {
          continue;
        }
        if (typeof m !== "object" || !("onRequest" in m || "onResponse" in m || "onError" in m)) {
          throw new Error("Middleware must be an object with one of `onRequest()`, `onResponse() or `onError()`");
        }
        globalMiddlewares.push(m);
      }
    },
    /** Unregister middleware */
    eject(...middleware) {
      for (const m of middleware) {
        const i = globalMiddlewares.indexOf(m);
        if (i !== -1) {
          globalMiddlewares.splice(i, 1);
        }
      }
    }
  };
}
function serializePrimitiveParam(name, value, options) {
  if (value === void 0 || value === null) {
    return "";
  }
  if (typeof value === "object") {
    throw new Error(
      "Deeply-nested arrays/objects aren\u2019t supported. Provide your own `querySerializer()` to handle these."
    );
  }
  return `${name}=${options?.allowReserved === true ? value : encodeURIComponent(value)}`;
}
function serializeObjectParam(name, value, options) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const values = [];
  const joiner = {
    simple: ",",
    label: ".",
    matrix: ";"
  }[options.style] || "&";
  if (options.style !== "deepObject" && options.explode === false) {
    for (const k in value) {
      values.push(k, options.allowReserved === true ? value[k] : encodeURIComponent(value[k]));
    }
    const final2 = values.join(",");
    switch (options.style) {
      case "form": {
        return `${name}=${final2}`;
      }
      case "label": {
        return `.${final2}`;
      }
      case "matrix": {
        return `;${name}=${final2}`;
      }
      default: {
        return final2;
      }
    }
  }
  for (const k in value) {
    const finalName = options.style === "deepObject" ? `${name}[${k}]` : k;
    values.push(serializePrimitiveParam(finalName, value[k], options));
  }
  const final = values.join(joiner);
  return options.style === "label" || options.style === "matrix" ? `${joiner}${final}` : final;
}
function serializeArrayParam(name, value, options) {
  if (!Array.isArray(value)) {
    return "";
  }
  if (options.explode === false) {
    const joiner2 = { form: ",", spaceDelimited: "%20", pipeDelimited: "|" }[options.style] || ",";
    const final = (options.allowReserved === true ? value : value.map((v) => encodeURIComponent(v))).join(joiner2);
    switch (options.style) {
      case "simple": {
        return final;
      }
      case "label": {
        return `.${final}`;
      }
      case "matrix": {
        return `;${name}=${final}`;
      }
      // case "spaceDelimited":
      // case "pipeDelimited":
      default: {
        return `${name}=${final}`;
      }
    }
  }
  const joiner = { simple: ",", label: ".", matrix: ";" }[options.style] || "&";
  const values = [];
  for (const v of value) {
    if (options.style === "simple" || options.style === "label") {
      values.push(options.allowReserved === true ? v : encodeURIComponent(v));
    } else {
      values.push(serializePrimitiveParam(name, v, options));
    }
  }
  return options.style === "label" || options.style === "matrix" ? `${joiner}${values.join(joiner)}` : values.join(joiner);
}
function createQuerySerializer(options) {
  return function querySerializer(queryParams) {
    const search = [];
    if (queryParams && typeof queryParams === "object") {
      for (const name in queryParams) {
        const value = queryParams[name];
        if (value === void 0 || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) {
            continue;
          }
          search.push(
            serializeArrayParam(name, value, {
              style: "form",
              explode: true,
              ...options?.array,
              allowReserved: options?.allowReserved || false
            })
          );
          continue;
        }
        if (typeof value === "object") {
          search.push(
            serializeObjectParam(name, value, {
              style: "deepObject",
              explode: true,
              ...options?.object,
              allowReserved: options?.allowReserved || false
            })
          );
          continue;
        }
        search.push(serializePrimitiveParam(name, value, options));
      }
    }
    return search.join("&");
  };
}
function defaultPathSerializer(pathname, pathParams) {
  let nextURL = pathname;
  for (const match of pathname.match(PATH_PARAM_RE) ?? []) {
    let name = match.substring(1, match.length - 1);
    let explode = false;
    let style = "simple";
    if (name.endsWith("*")) {
      explode = true;
      name = name.substring(0, name.length - 1);
    }
    if (name.startsWith(".")) {
      style = "label";
      name = name.substring(1);
    } else if (name.startsWith(";")) {
      style = "matrix";
      name = name.substring(1);
    }
    if (!pathParams || pathParams[name] === void 0 || pathParams[name] === null) {
      continue;
    }
    const value = pathParams[name];
    if (Array.isArray(value)) {
      nextURL = nextURL.replace(match, serializeArrayParam(name, value, { style, explode }));
      continue;
    }
    if (typeof value === "object") {
      nextURL = nextURL.replace(match, serializeObjectParam(name, value, { style, explode }));
      continue;
    }
    if (style === "matrix") {
      nextURL = nextURL.replace(match, `;${serializePrimitiveParam(name, value)}`);
      continue;
    }
    nextURL = nextURL.replace(match, style === "label" ? `.${encodeURIComponent(value)}` : encodeURIComponent(value));
  }
  return nextURL;
}
function defaultBodySerializer(body, headers) {
  if (body instanceof FormData) {
    return body;
  }
  if (headers) {
    const contentType = headers.get instanceof Function ? headers.get("Content-Type") ?? headers.get("content-type") : headers["Content-Type"] ?? headers["content-type"];
    if (contentType === "application/x-www-form-urlencoded") {
      return new URLSearchParams(body).toString();
    }
  }
  return JSON.stringify(body);
}
function createFinalURL(pathname, options) {
  let finalURL = `${options.baseUrl}${pathname}`;
  if (options.params?.path) {
    finalURL = options.pathSerializer(finalURL, options.params.path);
  }
  let search = options.querySerializer(options.params.query ?? {});
  if (search.startsWith("?")) {
    search = search.substring(1);
  }
  if (search) {
    finalURL += `?${search}`;
  }
  return finalURL;
}
function mergeHeaders(...allHeaders) {
  const finalHeaders = new Headers();
  for (const h of allHeaders) {
    if (!h || typeof h !== "object") {
      continue;
    }
    const iterator = h instanceof Headers ? h.entries() : Object.entries(h);
    for (const [k, v] of iterator) {
      if (v === null) {
        finalHeaders.delete(k);
      } else if (Array.isArray(v)) {
        for (const v2 of v) {
          finalHeaders.append(k, v2);
        }
      } else if (v !== void 0) {
        finalHeaders.set(k, v);
      }
    }
  }
  return finalHeaders;
}
function removeTrailingSlash(url) {
  if (url.endsWith("/")) {
    return url.substring(0, url.length - 1);
  }
  return url;
}

// ../agent-control/dist/index.mjs
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var A2A_TASK_STATES = [
  "SUBMITTED",
  "WORKING",
  "INPUT_REQUIRED",
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "REJECTED",
  "AUTH_REQUIRED"
];
var A2A_ROLES = ["USER", "AGENT"];
var TASK_STATE_SET = new Set(A2A_TASK_STATES);
var ROLE_SET = new Set(A2A_ROLES);
var PART_CONTENT_KEYS = ["text", "raw", "url", "data"];
var PART_KEYS = /* @__PURE__ */ new Set([
  ...PART_CONTENT_KEYS,
  "metadata",
  "filename",
  "mediaType"
]);
var MESSAGE_KEYS = /* @__PURE__ */ new Set([
  "messageId",
  "role",
  "parts",
  "contextId",
  "taskId",
  "metadata",
  "extensions",
  "referenceTaskIds"
]);
var ARTIFACT_KEYS = /* @__PURE__ */ new Set([
  "artifactId",
  "parts",
  "name",
  "description",
  "metadata",
  "extensions"
]);
var STATUS_KEYS = /* @__PURE__ */ new Set(["state", "message", "timestamp"]);
var TASK_KEYS = /* @__PURE__ */ new Set([
  "id",
  "status",
  "contextId",
  "artifacts",
  "history",
  "metadata"
]);
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function rejectUnknownKeys(obj, allowed, path, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push(`${path}: unknown field '${key}' is not permitted`);
    }
  }
}
function checkOptionalString(obj, key, path, errors) {
  if (key in obj && typeof obj[key] !== "string") {
    errors.push(`${path}.${key}: expected string`);
  }
}
function checkOptionalStringArray(obj, key, path, errors) {
  if (!(key in obj)) return;
  const arr = obj[key];
  if (!Array.isArray(arr)) {
    errors.push(`${path}.${key}: expected array of string`);
    return;
  }
  arr.forEach((el, i) => {
    if (typeof el !== "string") {
      errors.push(`${path}.${key}[${i}]: expected string`);
    }
  });
}
function checkOptionalObject(obj, key, path, errors) {
  if (key in obj && !isPlainObject(obj[key])) {
    errors.push(`${path}.${key}: expected object`);
  }
}
function validatePart(input, path, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, PART_KEYS, path, errors);
  const contentPresent = PART_CONTENT_KEYS.filter((k) => k in input);
  if (contentPresent.length !== 1) {
    errors.push(
      `${path}: exactly one content field (text|raw|url|data) required, found ${contentPresent.length}`
    );
  }
  if ("text" in input && typeof input.text !== "string") {
    errors.push(`${path}.text: expected string`);
  }
  if ("raw" in input && typeof input.raw !== "string") {
    errors.push(`${path}.raw: expected string`);
  }
  if ("url" in input && typeof input.url !== "string") {
    errors.push(`${path}.url: expected string`);
  }
  checkOptionalObject(input, "metadata", path, errors);
  checkOptionalString(input, "filename", path, errors);
  checkOptionalString(input, "mediaType", path, errors);
}
function validateParts(input, path, errors) {
  if (!Array.isArray(input)) {
    errors.push(`${path}: expected array of parts`);
    return;
  }
  if (input.length < 1) {
    errors.push(`${path}: at least one part required`);
  }
  input.forEach((p, i) => validatePart(p, `${path}[${i}]`, errors));
}
function validateMessageInto(input, path, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, MESSAGE_KEYS, path, errors);
  if (typeof input.messageId !== "string" || input.messageId.length === 0) {
    errors.push(`${path}.messageId: required non-empty string`);
  }
  if (typeof input.role !== "string" || !ROLE_SET.has(input.role)) {
    errors.push(
      `${path}.role: required, must be one of ${A2A_ROLES.join(" | ")}`
    );
  }
  if (!("parts" in input)) {
    errors.push(`${path}.parts: required`);
  } else {
    validateParts(input.parts, `${path}.parts`, errors);
  }
  checkOptionalString(input, "contextId", path, errors);
  checkOptionalString(input, "taskId", path, errors);
  checkOptionalObject(input, "metadata", path, errors);
  checkOptionalStringArray(input, "extensions", path, errors);
  checkOptionalStringArray(input, "referenceTaskIds", path, errors);
}
function validateArtifactInto(input, path, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, ARTIFACT_KEYS, path, errors);
  if (typeof input.artifactId !== "string" || input.artifactId.length === 0) {
    errors.push(`${path}.artifactId: required non-empty string`);
  }
  if (!("parts" in input)) {
    errors.push(`${path}.parts: required`);
  } else {
    validateParts(input.parts, `${path}.parts`, errors);
  }
  checkOptionalString(input, "name", path, errors);
  checkOptionalString(input, "description", path, errors);
  checkOptionalObject(input, "metadata", path, errors);
  checkOptionalStringArray(input, "extensions", path, errors);
}
function validateStatusInto(input, path, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, STATUS_KEYS, path, errors);
  if (typeof input.state !== "string" || !TASK_STATE_SET.has(input.state)) {
    errors.push(
      `${path}.state: required, must be one of ${A2A_TASK_STATES.join(" | ")}`
    );
  }
  if ("message" in input) {
    validateMessageInto(input.message, `${path}.message`, errors);
  }
  checkOptionalString(input, "timestamp", path, errors);
}
function validateTaskInto(input, path, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, TASK_KEYS, path, errors);
  if (typeof input.id !== "string" || input.id.length === 0) {
    errors.push(`${path}.id: required non-empty string`);
  }
  if (!("status" in input)) {
    errors.push(`${path}.status: required`);
  } else {
    validateStatusInto(input.status, `${path}.status`, errors);
  }
  checkOptionalString(input, "contextId", path, errors);
  if ("artifacts" in input) {
    if (!Array.isArray(input.artifacts)) {
      errors.push(`${path}.artifacts: expected array`);
    } else {
      input.artifacts.forEach(
        (a, i) => validateArtifactInto(a, `${path}.artifacts[${i}]`, errors)
      );
    }
  }
  if ("history" in input) {
    if (!Array.isArray(input.history)) {
      errors.push(`${path}.history: expected array`);
    } else {
      input.history.forEach(
        (m, i) => validateMessageInto(m, `${path}.history[${i}]`, errors)
      );
    }
  }
  checkOptionalObject(input, "metadata", path, errors);
}
function validateA2aMessage(input) {
  const errors = [];
  validateMessageInto(input, "message", errors);
  return errors.length === 0 ? { valid: true, value: input, errors: [] } : { valid: false, value: null, errors };
}
function validateA2aTask(input) {
  const errors = [];
  validateTaskInto(input, "task", errors);
  return errors.length === 0 ? { valid: true, value: input, errors: [] } : { valid: false, value: null, errors };
}
var A2A_PROTOCOL_LIMITS = {
  ordinaryFrameBytes: 65536,
  taskCreateOuterFrameBytes: 327680,
  taskUpdateOuterFrameBytes: 1572864,
  taskCreateInputBytes: 262144,
  taskCreateEnvelopeBytes: 65536,
  identifierBytes: 256,
  messageTextBytes: 16384,
  messagePartsBytes: 65536,
  artifactsPerUpdate: 50,
  artifactLabelBytes: 256,
  artifactValueBytes: 2048,
  taskUpdateResultBytes: 1048576,
  diagnosticsPerUpdate: 16,
  diagnosticsBytesPerUpdate: 8192
};
var A2A_TASK_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
var DECIMAL_REVISION_RE = /^[1-9][0-9]*$/;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var CANONICAL_FRAMEWORKS = /* @__PURE__ */ new Set([
  "claude_code",
  "codex",
  "openclaw",
  "hermes"
]);
var HANDLER_STATES = /* @__PURE__ */ new Set([
  "current",
  "outdated_unedited",
  "owner_modified",
  "example_scaffold",
  "not_installed_apply_pending",
  "not_installed_custom",
  "missing_deleted",
  "custom_no_reference",
  "not_reported"
]);
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
  const keySet = new Set(allowed);
  return Object.keys(value).every((key) => keySet.has(key));
}
function isNonEmptyString(value, maxBytes = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "string" || value.length === 0) return false;
  const size = utf8ByteLength(value);
  return size !== null && size <= maxBytes;
}
function utf8ByteLength(value) {
  let size = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint >= 55296 && codePoint <= 57343) return null;
    if (codePoint <= 127) size += 1;
    else if (codePoint <= 2047) size += 2;
    else if (codePoint <= 65535) size += 3;
    else size += 4;
  }
  return size;
}
function unicodeScalarCompare(left, right) {
  const a = [...left].map((char) => char.codePointAt(0));
  const b = [...right].map((char) => char.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index])
      return a[index] - b[index];
  }
  return a.length - b.length;
}
function conservativeJsonStringBudget(value) {
  let size = 2;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint >= 55296 && codePoint <= 57343) return null;
    if (codePoint <= 31) size += 6;
    else if (codePoint === 34 || codePoint === 92) size += 2;
    else {
      const bytes = utf8ByteLength(char);
      if (bytes === null) return null;
      size += bytes;
    }
  }
  return size;
}
function conservativeJsonSizeBudget(value) {
  const ancestors = /* @__PURE__ */ new WeakSet();
  const visit = (current) => {
    if (current === null) return 4;
    if (typeof current === "boolean") return current ? 4 : 5;
    if (typeof current === "number")
      return Number.isFinite(current) ? 24 : null;
    if (typeof current === "string")
      return conservativeJsonStringBudget(current);
    if (typeof current !== "object") return null;
    if (ancestors.has(current)) return null;
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        let size2 = 2 + Math.max(0, current.length - 1);
        for (const item of current) {
          const itemSize = visit(item);
          if (itemSize === null) return null;
          size2 += itemSize;
        }
        return size2;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(current).length > 0) {
        return null;
      }
      const object = current;
      const keys = Object.keys(object).sort(unicodeScalarCompare);
      let size = 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        const keySize = conservativeJsonStringBudget(key);
        const itemSize = visit(object[key]);
        if (keySize === null || itemSize === null) return null;
        size += keySize + 1 + itemSize;
      }
      return size;
    } catch {
      return null;
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value);
}
function serializedJsonByteLength(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === void 0 ? null : utf8ByteLength(serialized);
  } catch {
    return null;
  }
}
function a2aMessageTextWithinLimit(value) {
  return value.parts.every((part) => {
    if (part.text === void 0) return true;
    const size = utf8ByteLength(part.text);
    return size !== null && size <= A2A_PROTOCOL_LIMITS.messageTextBytes;
  });
}
function a2aArtifactWithinLimits(value) {
  if (value.name !== void 0 && (utf8ByteLength(value.name) === null || utf8ByteLength(value.name) > A2A_PROTOCOL_LIMITS.artifactLabelBytes)) {
    return false;
  }
  return value.parts.every((part) => {
    if (part.text !== void 0 && (utf8ByteLength(part.text) === null || utf8ByteLength(part.text) > A2A_PROTOCOL_LIMITS.artifactValueBytes)) {
      return false;
    }
    if (part.url !== void 0 && (utf8ByteLength(part.url) === null || utf8ByteLength(part.url) > A2A_PROTOCOL_LIMITS.artifactValueBytes)) {
      return false;
    }
    if (part.data !== void 0) {
      const size = typeof part.data === "string" ? utf8ByteLength(part.data) : conservativeJsonSizeBudget(part.data);
      if (size === null || size > A2A_PROTOCOL_LIMITS.artifactValueBytes) {
        return false;
      }
    }
    return true;
  });
}
function validA2aMessage(value, textLimit = false, partsLimit = false) {
  const result = validateA2aMessage(value);
  const partsBudget = result.valid ? serializedJsonByteLength(result.value.parts) : null;
  return result.valid && conservativeJsonSizeBudget(value) !== null && (!partsLimit || partsBudget !== null && partsBudget <= A2A_PROTOCOL_LIMITS.messagePartsBytes) && (!textLimit || a2aMessageTextWithinLimit(result.value));
}
function validA2aArtifact(value) {
  const task = validateA2aTask({
    id: "contract-validation",
    status: { state: "SUBMITTED" },
    artifacts: [value]
  });
  return task.valid && conservativeJsonSizeBudget(value) !== null && a2aArtifactWithinLimits(task.value.artifacts?.[0]);
}
function validTaskUpdateDiagnostics(value) {
  if (!Array.isArray(value) || value.length > A2A_PROTOCOL_LIMITS.diagnosticsPerUpdate)
    return false;
  let aggregate = 0;
  for (const item of value) {
    if (!isPlainObject2(item) || !hasOnlyKeys(item, ["kind", "reasonCode", "message", "details"]) || typeof item.kind !== "string" || !A2A_TASK_TYPE_PATTERN.test(item.kind) || item.reasonCode !== void 0 && typeof item.reasonCode !== "string" || item.message !== void 0 && typeof item.message !== "string" || item.details !== void 0 && !isPlainObject2(item.details))
      return false;
    const reasonBytes = item.reasonCode === void 0 ? 0 : utf8ByteLength(item.reasonCode);
    const messageBytes = item.message === void 0 ? 0 : utf8ByteLength(item.message);
    const detailsBytes = item.details === void 0 || Object.keys(item.details).length === 0 ? 0 : utf8ByteLength(JSON.stringify(item.details));
    if (reasonBytes === null || messageBytes === null || detailsBytes === null)
      return false;
    aggregate += reasonBytes + messageBytes + detailsBytes;
  }
  return aggregate <= A2A_PROTOCOL_LIMITS.diagnosticsBytesPerUpdate;
}
function isRevision(value) {
  return typeof value === "string" && DECIMAL_REVISION_RE.test(value);
}
function isTaskType(value) {
  return typeof value === "string" && A2A_TASK_TYPE_PATTERN.test(value);
}
function isDispatchEventContext(value) {
  if (!isPlainObject2(value) || !hasOnlyKeys(value, ["origin", "sender", "provider", "delivery_id"]) || !isPlainObject2(value.sender) || !hasOnlyKeys(value.sender, ["kind", "identity"]))
    return false;
  const sender = value.sender;
  if (value.origin === "send") {
    return (sender.kind === "user" || sender.kind === "agent") && typeof sender.identity === "string" && UUID_RE.test(sender.identity) && value.provider === void 0 && value.delivery_id === void 0;
  }
  return value.origin === "webhook" && sender.kind === "coordinator" && sender.identity === "spellguard" && isNonEmptyString(value.provider, A2A_PROTOCOL_LIMITS.identifierBytes) && isNonEmptyString(value.delivery_id, A2A_PROTOCOL_LIMITS.identifierBytes);
}
var DELIVERY_OUTCOMES = /* @__PURE__ */ new Set([
  "injected",
  "resumed",
  "ledger_only",
  "delivery_failed"
]);
function isDeliveryOutcome(value) {
  return typeof value === "string" && DELIVERY_OUTCOMES.has(value);
}
function isTaskTypeList(value) {
  return Array.isArray(value) && value.every(isTaskType);
}
function isBlockedTaskTypes(value) {
  return Array.isArray(value) && value.every(
    (entry) => isPlainObject2(entry) && hasOnlyKeys(entry, ["task_type", "cause"]) && isTaskType(entry.task_type) && isNonEmptyString(entry.cause, 500)
  );
}
function isHandlerInventory(value) {
  return Array.isArray(value) && value.every(
    (entry) => isPlainObject2(entry) && hasOnlyKeys(entry, [
      "task_type",
      "state",
      "path",
      "installed_hash",
      "current_hash",
      "dist_hash",
      "blocking_cause"
    ]) && isTaskType(entry.task_type) && typeof entry.state === "string" && HANDLER_STATES.has(entry.state) && isNonEmptyString(entry.path, 4096) && (entry.installed_hash === void 0 || isNonEmptyString(entry.installed_hash, 256)) && (entry.current_hash === void 0 || isNonEmptyString(entry.current_hash, 256)) && (entry.dist_hash === void 0 || isNonEmptyString(entry.dist_hash, 256)) && (entry.blocking_cause === void 0 || isNonEmptyString(entry.blocking_cause, 500))
  );
}
function isConfigApplication(value) {
  return isRevision(value.config_revision) && isTaskTypeList(value.applied_task_types) && isBlockedTaskTypes(value.blocked_task_types) && (value.superseded === void 0 || typeof value.superseded === "boolean");
}
function isMaintenanceApplication(value) {
  return isNonEmptyString(value.operation_id, 256) && (value.status === "applied" || value.status === "blocked") && isRevision(value.config_revision) && (value.reason === void 0 || isNonEmptyString(value.reason, 500));
}
var PUBLIC_TASK_RESPONSE_KEYS = [
  "id",
  "contextId",
  "organizationId",
  "senderKind",
  "senderAgentId",
  "senderUserId",
  "recipientAgentId",
  "originatingAgentId",
  "originatingAgentIdentity",
  "originatingSessionId",
  "framework",
  "type",
  "state",
  "artifactUrl",
  "metadata",
  "resultPayload",
  "deferred",
  "lastProgressAt",
  "lastSupervisionKeepaliveAt",
  "effectiveDeadlineAt",
  "workingTimeoutSeconds",
  "hasUnansweredWorkerMessage",
  "threadRecordCount",
  "threadWriteAttemptCount",
  "suppressedMessageCount",
  "suppressedProgressCount",
  "artifactCount",
  "terminalAt",
  "createdAt",
  "updatedAt"
];
var TASK_SUMMARY_RESPONSE_KEYS = [
  ...PUBLIC_TASK_RESPONSE_KEYS.filter(
    (key) => key !== "originatingAgentId" && key !== "originatingAgentIdentity" && key !== "originatingSessionId"
  ),
  "typeLabel",
  "stateLabel"
];
function nullableString(value) {
  return value === null || typeof value === "string";
}
function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}
function validTaskResponseBase(value, summary) {
  const keys = summary ? TASK_SUMMARY_RESPONSE_KEYS : PUBLIC_TASK_RESPONSE_KEYS;
  return exactKeys(value, keys) && isNonEmptyString(value.id) && isNonEmptyString(value.contextId) && isNonEmptyString(value.organizationId) && (value.senderKind === "agent" || value.senderKind === "coordinator" || value.senderKind === "user") && nullableString(value.senderAgentId) && nullableString(value.senderUserId) && isNonEmptyString(value.recipientAgentId) && (summary || nullableString(value.originatingAgentId) && nullableString(value.originatingAgentIdentity) && nullableString(value.originatingSessionId)) && nullableString(value.framework) && isNonEmptyString(value.type) && A2A_TASK_STATES.includes(value.state) && nullableString(value.artifactUrl) && isPlainObject2(value.metadata) && typeof value.deferred === "boolean" && nullableString(value.lastProgressAt) && nullableString(value.lastSupervisionKeepaliveAt) && nullableString(value.effectiveDeadlineAt) && (value.workingTimeoutSeconds === null || typeof value.workingTimeoutSeconds === "number") && typeof value.hasUnansweredWorkerMessage === "boolean" && typeof value.threadRecordCount === "number" && typeof value.threadWriteAttemptCount === "number" && typeof value.suppressedMessageCount === "number" && typeof value.suppressedProgressCount === "number" && typeof value.artifactCount === "number" && nullableString(value.terminalAt) && isNonEmptyString(value.createdAt) && isNonEmptyString(value.updatedAt) && (!summary || isNonEmptyString(value.typeLabel) && isNonEmptyString(value.stateLabel));
}
function validatePublicTaskResponse(value) {
  return isPlainObject2(value) && validTaskResponseBase(value, false);
}
function validateTaskDetailResponse(value) {
  if (!isPlainObject2(value)) return false;
  const { thread, artifacts, diagnostics, ...summary } = value;
  return validTaskResponseBase(summary, true) && Array.isArray(thread) && Array.isArray(artifacts) && Array.isArray(diagnostics) && thread.every(validateTaskThreadResponse) && artifacts.every(validateTaskArtifactResponse) && diagnostics.every(validateTaskDiagnosticResponse);
}
function nonnegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function validateTaskThreadResponse(value) {
  return isPlainObject2(value) && exactKeys(value, [
    "id",
    "sequence",
    "recordKind",
    "messageId",
    "senderRole",
    "senderKind",
    "senderAgentId",
    "senderAgentIdentity",
    "senderUserId",
    "senderUserIdentity",
    "senderDisplayName",
    "text",
    "parts",
    "postTerminal",
    "deliveryState",
    "deliveryReason",
    "terminalState",
    "terminalCause",
    "createdAt"
  ]) && isNonEmptyString(value.id) && nonnegativeInteger(value.sequence) && (value.recordKind === "progress" || value.recordKind === "message" || value.recordKind === "terminal") && nullableString(value.messageId) && (value.senderRole === null || value.senderRole === "USER" || value.senderRole === "AGENT") && (value.senderKind === null || value.senderKind === "agent" || value.senderKind === "user" || value.senderKind === "coordinator" || value.senderKind === "handler" || value.senderKind === "daemon") && nullableString(value.senderAgentId) && nullableString(value.senderAgentIdentity) && nullableString(value.senderUserId) && nullableString(value.senderUserIdentity) && nullableString(value.senderDisplayName) && nullableString(value.text) && typeof value.postTerminal === "boolean" && nullableString(value.deliveryState) && nullableString(value.deliveryReason) && (value.terminalState === null || A2A_TASK_STATES.includes(value.terminalState)) && (value.terminalCause === null || isPlainObject2(value.terminalCause)) && isNonEmptyString(value.createdAt);
}
function validateTaskArtifactResponse(value) {
  return isPlainObject2(value) && exactKeys(value, [
    "id",
    "artifactId",
    "sequence",
    "type",
    "value",
    "displayLabel",
    "metadata",
    "createdAt"
  ]) && isNonEmptyString(value.id) && isNonEmptyString(value.artifactId) && nonnegativeInteger(value.sequence) && isNonEmptyString(value.type) && typeof value.value === "string" && nullableString(value.displayLabel) && isPlainObject2(value.metadata) && isNonEmptyString(value.createdAt);
}
function validateTaskDiagnosticResponse(value) {
  return isPlainObject2(value) && exactKeys(value, [
    "id",
    "sequence",
    "kind",
    "reasonCode",
    "message",
    "details",
    "createdAt"
  ]) && isNonEmptyString(value.id) && nonnegativeInteger(value.sequence) && isNonEmptyString(value.kind) && nullableString(value.reasonCode) && nullableString(value.message) && isPlainObject2(value.details) && isNonEmptyString(value.createdAt);
}
function validateA2aAckResult(value) {
  if (!isPlainObject2(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "task_update":
      return hasOnlyKeys(value, ["kind", "outcome", "response"]) && (value.outcome === "persisted" || value.outcome === "already_terminal" || value.outcome === "thread_bound_reached") && (value.response === void 0 || validatePublicTaskResponse(value.response));
    case "message":
      return hasOnlyKeys(value, ["kind", "outcome", "message_id", "response"]) && value.outcome === "persisted" && isNonEmptyString(value.message_id) && (value.response === void 0 || isPlainObject2(value.response) && exactKeys(value.response, ["messageId", "postTerminal"]) && isNonEmptyString(value.response.messageId) && typeof value.response.postTerminal === "boolean");
    case "task_create":
      return hasOnlyKeys(value, ["kind", "task", "outcome", "response"]) && validateA2aTask(value.task).valid && conservativeJsonSizeBudget(value.task) !== null && (value.outcome === void 0 || value.outcome === "created" || value.outcome === "duplicate" || value.outcome === "delivery_failed" || // Acceptance, not failure: the recipient box was asleep, the task is
      // durably parked and a wake was requested. The server emits this for
      // task_create; rejecting it drops the entire ack frame (see the
      // declared `A2aAckResult` union and the Go daemon's mirror).
      value.outcome === "pending_wake") && (value.response === void 0 || validatePublicTaskResponse(value.response));
    case "task_read":
      return hasOnlyKeys(value, ["kind", "task", "response"]) && validateA2aTask(value.task).valid && conservativeJsonSizeBudget(value.task) !== null && (value.response === void 0 || validateTaskDetailResponse(value.response));
    case "config_applied":
      return hasOnlyKeys(value, [
        "kind",
        "config_revision",
        "applied_task_types",
        "blocked_task_types",
        "superseded"
      ]) && isConfigApplication(value);
    case "maintenance":
      return hasOnlyKeys(value, [
        "kind",
        "operation_id",
        "status",
        "config_revision",
        "reason"
      ]) && isMaintenanceApplication(value);
    default:
      return false;
  }
}
function validateA2aContractFrame(value, direction) {
  if (!isPlainObject2(value) || typeof value.type !== "string") return false;
  const serverBase = direction === "server" && isNonEmptyString(value.seq) && isNonEmptyString(value.ts);
  const clientBase = direction === "client" && isNonEmptyString(value.client_msg_id, A2A_PROTOCOL_LIMITS.identifierBytes);
  switch (value.type) {
    case "a2a_task_dispatch":
      return serverBase && hasOnlyKeys(value, [
        "type",
        "seq",
        "ts",
        "task",
        "message",
        "framework",
        "recipient_agent_id",
        "sender_agent_id",
        "org_id",
        "event_context"
      ]) && isNonEmptyString(
        value.recipient_agent_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      ) && (value.sender_agent_id === void 0 || isNonEmptyString(
        value.sender_agent_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      )) && (value.org_id === void 0 || isNonEmptyString(
        value.org_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      )) && (value.framework === void 0 || typeof value.framework === "string" && CANONICAL_FRAMEWORKS.has(value.framework)) && (value.event_context === void 0 || isDispatchEventContext(value.event_context)) && validateA2aTask(value.task).valid && validateA2aMessage(value.message).valid;
    case "config_updated":
      return serverBase && hasOnlyKeys(value, [
        "type",
        "seq",
        "ts",
        "config",
        "triggers_rotation",
        "config_revision"
      ]) && isPlainObject2(value.config) && typeof value.triggers_rotation === "boolean" && isRevision(value.config_revision);
    case "a2a_maintenance":
      return serverBase && hasOnlyKeys(value, [
        "type",
        "seq",
        "ts",
        "operation_id",
        "action",
        "config_revision"
      ]) && isNonEmptyString(value.operation_id, 256) && value.action === "backfill" && isRevision(value.config_revision);
    case "a2a_config_applied":
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "config_revision",
        "applied_task_types",
        "blocked_task_types",
        "superseded"
      ]) && isConfigApplication(value);
    case "a2a_handler_inventory":
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "config_revision",
        "handlers"
      ]) && isRevision(value.config_revision) && isHandlerInventory(value.handlers);
    case "a2a_maintenance_result":
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "operation_id",
        "status",
        "config_revision",
        "reason"
      ]) && isMaintenanceApplication(value);
    case "a2a_supervision_keepalive":
    case "a2a_task_read":
    case "a2a_deferred_accepted":
      return clientBase && hasOnlyKeys(value, ["type", "client_msg_id", "taskId"]) && isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes);
    case "a2a_message_delivery":
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "taskId",
        "messageId",
        "reason",
        "outcome"
      ]) && isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes) && isNonEmptyString(
        value.messageId,
        A2A_PROTOCOL_LIMITS.identifierBytes
      ) && isDeliveryOutcome(value.outcome) && // A clean injection needs no explanation; every other terminal state
      // must name why, so no message ends as an unexplained failure.
      (value.outcome === "injected" ? value.reason === void 0 : isNonEmptyString(value.reason, A2A_PROTOCOL_LIMITS.identifierBytes));
    case "a2a_session_register":
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "session_id",
        "framework",
        "working_directory",
        "taskId"
      ]) && isNonEmptyString(value.session_id, 256) && typeof value.framework === "string" && CANONICAL_FRAMEWORKS.has(value.framework) && isNonEmptyString(value.working_directory, 4096) && (value.taskId === void 0 || isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes));
    case "a2a_task_create": {
      const messageBudget = conservativeJsonSizeBudget(value.message);
      const frameBudget = conservativeJsonSizeBudget(value);
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "recipient_agent_id",
        "task_type",
        "idempotency_key",
        "message",
        "originating_session_id"
      ]) && isNonEmptyString(
        value.recipient_agent_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      ) && isTaskType(value.task_type) && isNonEmptyString(value.idempotency_key, 256) && validA2aMessage(value.message, true) && messageBudget !== null && messageBudget <= A2A_PROTOCOL_LIMITS.taskCreateInputBytes && frameBudget !== null && frameBudget - messageBudget <= A2A_PROTOCOL_LIMITS.taskCreateEnvelopeBytes && (value.originating_session_id === void 0 || isNonEmptyString(value.originating_session_id, 256));
    }
    case "a2a_task_update": {
      const artifacts = value.artifacts;
      const artifact = value.artifact;
      const artifactsValid = artifacts === void 0 || Array.isArray(artifacts) && artifacts.every(validA2aArtifact);
      const artifactValid = artifact === void 0 || validA2aArtifact(artifact);
      const artifactCount = (artifact === void 0 ? 0 : 1) + (Array.isArray(artifacts) ? artifacts.length : 0);
      const resultBudget = value.result === void 0 ? 0 : conservativeJsonSizeBudget(value.result);
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "taskId",
        "state",
        "message",
        "artifact",
        "artifacts",
        "result",
        "diagnostics",
        "reasonSource",
        "deferred",
        "framework"
      ]) && isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes) && typeof value.state === "string" && A2A_TASK_STATES.includes(value.state) && (value.message === void 0 || validA2aMessage(value.message, true)) && artifactValid && artifactsValid && artifactCount <= A2A_PROTOCOL_LIMITS.artifactsPerUpdate && resultBudget !== null && resultBudget <= A2A_PROTOCOL_LIMITS.taskUpdateResultBytes && (value.diagnostics === void 0 || validTaskUpdateDiagnostics(value.diagnostics)) && // Present-or-absent, and 'handler' is the ONLY admissible value: a
      // daemon-authored reason is the default, so there is no positive daemon
      // marker to accept — anything else is drift and fails the whole frame.
      (value.reasonSource === void 0 || value.reasonSource === "handler") && (value.deferred === void 0 || value.deferred === true && value.state === "WORKING") && (value.framework === void 0 || typeof value.framework === "string" && CANONICAL_FRAMEWORKS.has(value.framework));
    }
    case "a2a_message": {
      const common = validA2aMessage(value.message, true, true) && isNonEmptyString(
        value.recipient_agent_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      ) && (value.sender_agent_id === void 0 || isNonEmptyString(
        value.sender_agent_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      )) && (value.framework === void 0 || typeof value.framework === "string" && CANONICAL_FRAMEWORKS.has(value.framework)) && (value.target_session_id === void 0 || isNonEmptyString(value.target_session_id, 256));
      if (direction === "client") {
        return clientBase && hasOnlyKeys(value, [
          "type",
          "client_msg_id",
          "message",
          "recipient_agent_id",
          "sender_agent_id",
          "framework",
          "target_session_id"
        ]) && common;
      }
      return serverBase && hasOnlyKeys(value, [
        "type",
        "seq",
        "ts",
        "message",
        "recipient_agent_id",
        "sender_agent_id",
        "framework",
        "org_id",
        "target_session_id"
      ]) && common && (value.org_id === void 0 || isNonEmptyString(value.org_id, A2A_PROTOCOL_LIMITS.identifierBytes));
    }
    default:
      return false;
  }
}
function isGeneralizedServerEnvelopeValid(obj) {
  if (obj.type === "ack" && obj.result !== void 0) {
    return validateA2aAckResult(obj.result);
  }
  if (obj.type === "config_updated" && obj.config_revision !== void 0) {
    return validateA2aContractFrame(obj, "server");
  }
  if (obj.type === "a2a_maintenance") {
    return validateA2aContractFrame(obj, "server");
  }
  if (obj.type === "a2a_task_dispatch") {
    return validateA2aContractFrame(obj, "server");
  }
  if (obj.type === "a2a_message") {
    return validateA2aContractFrame(obj, "server");
  }
  return true;
}
var KNOWN_SERVER_FRAME_TYPES = /* @__PURE__ */ new Set([
  "hello",
  "credential_delivered",
  "credential_rotated",
  "credential_revoked",
  "github_grants_bundle",
  "github_grants_commit_confirmed",
  "config_updated",
  "ack",
  "error",
  "resume_window_exceeded",
  "login_code",
  "login_restart",
  "slack_event",
  "slack_event_blocked",
  "teams_activity",
  "teams_activity_blocked",
  // A2A collaboration-plane down frames (Task T2). `a2a_message` is
  // bidirectional; this is its server→box direction.
  "a2a_task_dispatch",
  "a2a_message",
  "a2a_maintenance"
]);
var A2A_FRAME_TYPES = /* @__PURE__ */ new Set([
  "a2a_config_applied",
  "a2a_deferred_accepted",
  "a2a_message_delivery",
  "a2a_handler_inventory",
  "a2a_maintenance",
  "a2a_maintenance_result",
  "a2a_task_dispatch",
  "a2a_task_update",
  "a2a_message",
  "a2a_session_register",
  "a2a_supervision_keepalive",
  "a2a_task_create",
  "a2a_task_read"
]);
function parseServerFrame(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw;
  if (typeof obj.type !== "string") return null;
  if (!KNOWN_SERVER_FRAME_TYPES.has(obj.type)) return null;
  if (obj.type === "github_grants_bundle") {
    if (!isGithubGrantsBundle(obj)) return null;
    return obj;
  }
  if (obj.type === "github_grants_commit_confirmed") {
    if (!hasOnlyKeys(obj, [
      "type",
      "protocol_version",
      "seq",
      "ts",
      "delivery_id",
      "grant_set_revision"
    ]) || obj.protocol_version !== "5" || typeof obj.seq !== "string" || typeof obj.ts !== "string" || typeof obj.delivery_id !== "string" || !UUID_RE.test(obj.delivery_id) || !isRevision(obj.grant_set_revision))
      return null;
    return obj;
  }
  if (A2A_FRAME_TYPES.has(obj.type) && conservativeJsonSizeBudget(obj) === null)
    return null;
  if (obj.type === "login_code") {
    if (typeof obj.code !== "string" || obj.code.length === 0) return null;
  }
  if (!isGeneralizedServerEnvelopeValid(obj)) return null;
  if (!isA2aServerPayloadValid(obj)) return null;
  return obj;
}
function isGithubGrantsBundle(value) {
  if (!hasOnlyKeys(value, [
    "type",
    "protocol_version",
    "seq",
    "ts",
    "delivery_id",
    "grant_set_revision",
    "credentials"
  ]) || value.protocol_version !== "5" || typeof value.seq !== "string" || typeof value.ts !== "string" || typeof value.delivery_id !== "string" || !UUID_RE.test(value.delivery_id) || !isRevision(value.grant_set_revision) || !Array.isArray(value.credentials))
    return false;
  const grantIds = /* @__PURE__ */ new Set();
  const installationIds = /* @__PURE__ */ new Set();
  const credentialIds = /* @__PURE__ */ new Set();
  const scopedTokenIds = /* @__PURE__ */ new Set();
  const numericInstallationIds = /* @__PURE__ */ new Set();
  const owners = /* @__PURE__ */ new Set();
  let memberAgentId;
  for (const raw of value.credentials) {
    if (!isPlainObject2(raw)) return false;
    const scope = raw.scope;
    const providerData = raw.provider_data;
    if (!hasOnlyKeys(raw, [
      "grant_id",
      "installation_record_id",
      "credential_id",
      "scoped_token_id",
      "agent_id",
      "provider",
      "kind",
      "status",
      "grant_revision",
      "grant_set_revision",
      "github_org_login",
      "github_org_display_name",
      "installation_id",
      "expires_at",
      "scoped_token",
      "access",
      "scope",
      "provider_data"
    ]) || raw.provider !== "github" || raw.kind !== "issued" || raw.status !== "valid" || typeof raw.grant_id !== "string" || !UUID_RE.test(raw.grant_id) || typeof raw.installation_record_id !== "string" || !UUID_RE.test(raw.installation_record_id) || typeof raw.credential_id !== "string" || !UUID_RE.test(raw.credential_id) || // NOT a UUID, unlike the four relational ids around it. This is GitHub's
    // INSTALLATION-TOKEN id — a number the mint path stringifies
    // (`scopedTokenId()` in `services/github/github-api.ts`) into the `text`
    // column `credentials.scoped_token_id`; real rows look like `5249971925`.
    // A UUID test here rejected every bundle the server actually sends, so a
    // marked agent's credential store stayed empty and git kept 401ing. It is
    // an OPAQUE identifier everywhere else in the codebase (the API contract
    // types it `z.string().min(1)`), and it is validated as one here: present,
    // a string, non-empty. Uniqueness within the bundle is still enforced
    // below.
    typeof raw.scoped_token_id !== "string" || raw.scoped_token_id.length === 0 || typeof raw.agent_id !== "string" || !UUID_RE.test(raw.agent_id) || !isRevision(raw.grant_revision) || raw.grant_set_revision !== value.grant_set_revision || typeof raw.github_org_login !== "string" || raw.github_org_login.length === 0 || typeof raw.github_org_display_name !== "string" || raw.github_org_display_name.trim().length === 0 || typeof raw.installation_id !== "number" || !Number.isSafeInteger(raw.installation_id) || raw.installation_id <= 0 || typeof raw.expires_at !== "string" || !Number.isFinite(Date.parse(raw.expires_at)) || typeof raw.scoped_token !== "string" || raw.scoped_token.length === 0 || !["read", "write"].includes(raw.access) || !isPlainObject2(scope) || !isPlainObject2(providerData) || !hasOnlyKeys(providerData, [
      "github_user_id",
      "github_login",
      "github_user_email",
      "git_author_name",
      "git_author_email"
    ]) || typeof providerData.github_user_id !== "number" || !Number.isSafeInteger(providerData.github_user_id) || // Strictly positive: no GitHub account has id 0, and 0 is precisely the
    // placeholder a missing identity used to produce server-side. The
    // plugins write this into the box's real git config, so a bundle whose
    // committer resolves to nobody is refused at the boundary too.
    providerData.github_user_id <= 0 || typeof providerData.github_login !== "string" || providerData.github_login.trim().length === 0 || !(providerData.github_user_email === null || typeof providerData.github_user_email === "string") || typeof providerData.git_author_name !== "string" || providerData.git_author_name.trim().length === 0 || typeof providerData.git_author_email !== "string" || providerData.git_author_email.trim().length === 0)
      return false;
    const owner = raw.github_org_login;
    const validScope = scope.mode === "all" && hasOnlyKeys(scope, ["mode"]) || scope.mode === "selected" && hasOnlyKeys(scope, ["mode", "repository_names"]) && Array.isArray(scope.repository_names) && scope.repository_names.length > 0 && scope.repository_names.every((name) => {
      if (typeof name !== "string" || name !== name.toLowerCase())
        return false;
      const parts = name.split("/");
      return parts.length === 2 && parts[0] === owner.toLowerCase() && parts[1].length > 0;
    }) && new Set(scope.repository_names).size === scope.repository_names.length;
    if (!validScope) return false;
    const normalizedLogin = owner.toLowerCase();
    if (grantIds.has(raw.grant_id) || installationIds.has(raw.installation_record_id) || credentialIds.has(raw.credential_id) || scopedTokenIds.has(raw.scoped_token_id) || numericInstallationIds.has(raw.installation_id) || memberAgentId !== void 0 && memberAgentId !== raw.agent_id || owners.has(normalizedLogin))
      return false;
    grantIds.add(raw.grant_id);
    installationIds.add(raw.installation_record_id);
    credentialIds.add(raw.credential_id);
    scopedTokenIds.add(raw.scoped_token_id);
    numericInstallationIds.add(raw.installation_id);
    memberAgentId = raw.agent_id;
    owners.add(normalizedLogin);
  }
  return true;
}
function isA2aServerPayloadValid(obj) {
  if (obj.type === "a2a_task_dispatch") {
    return validateA2aTask(obj.task).valid && validateA2aMessage(obj.message).valid && conservativeJsonSizeBudget(obj.task) !== null && conservativeJsonSizeBudget(obj.message) !== null;
  }
  if (obj.type === "a2a_message") {
    return validA2aMessage(obj.message, true, true) && conservativeJsonSizeBudget(obj.message) !== null;
  }
  return true;
}
var AGENT_CONTROL_CLOSE_CODES = {
  NORMAL: 1e3,
  INTERNAL_ERROR: 1011,
  BOOTSTRAP_ERROR: 4400,
  AUTH_FAILED: 4401,
  AGENT_OWNERSHIP: 4403,
  RESUME_WINDOW_EXCEEDED: 4413,
  /**
   * The channel displaced a registered socket that had stopped answering the
   * keepalive, so a newcomer could take the single-socket slot (S2).
   *
   * Distinct from `ALREADY_CONNECTED` because it points the OTHER way: 4429
   * tells a newcomer "someone live is already here", while this tells an
   * incumbent "you look dead and have been replaced". It is deliberately NOT
   * fatal to the client — a socket that receives it either really is a zombie
   * whose process is gone, or is a live daemon that was mis-judged and must
   * reconnect rather than exit.
   */
  STALE_SOCKET: 4410,
  ALREADY_CONNECTED: 4429,
  /**
   * Set ONLY on a deliberate move/re-bootstrap rotation; the sole trigger
   * for the plugin self-wipe. The close reason string is one of
   * `AUTH_SUPERSEDED_CLOSE_REASONS` — use that constant to match on it.
   */
  AUTH_SUPERSEDED: 4409,
  /**
   * The agent is quarantined: its channel is suspended, not revoked (#1348).
   * Sent only to a client that advertised `AGENT_SUSPEND_CAPABILITY`; any
   * other gets AUTH_FAILED (4401). The client drops every credential it
   * placed, keeps its identity, and reconnects with backoff (30 s, doubling to
   * 5 min). A quarantined agent's capable reconnect is answered with this code
   * too, until a release lets the upgrade through and the normal resume
   * re-delivers what is still granted. The reason is
   * `AGENT_SUSPENDED_CLOSE_REASON`.
   */
  AGENT_SUSPENDED: 4423
  // A SERVER_TRANSIENT (4503) code is intentionally not declared here: the
  // server's transient-failure paths (storage put errors, missing DB handle,
  // serialization throws) log and fall through rather than emitting a close
  // code. A structured signal could be added later, paired with a
  // server-side emit site.
};
var AUTH_SUPERSEDED_CLOSE_REASONS = {
  ATTACHED_ELSEWHERE: "attached_elsewhere",
  REASSIGNED: "reassigned"
};
var AGENT_SUSPEND_CAPABILITY = "agent_suspend_v1";
var FATAL_CLOSE_CODES = /* @__PURE__ */ new Set([
  // 4400 BOOTSTRAP_ERROR is wired up server-side. Without listing it here,
  // partysocket would auto-reconnect after a bootstrap-terminal failure and
  // the client would never surface the real error to the setup flow.
  AGENT_CONTROL_CLOSE_CODES.BOOTSTRAP_ERROR,
  AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED,
  AGENT_CONTROL_CLOSE_CODES.AGENT_OWNERSHIP
  // RESUME_WINDOW_EXCEEDED is intentionally NOT fatal — the protocol
  // contract says the client falls through to a fresh-bootstrap-style
  // recovery (reset cursor + projection, reconnect). The frame handler
  // (`case 'resume_window_exceeded'`) fast-forwards local state to the
  // server's `current_seq` and clears the projection; partysocket then
  // auto-reconnects, the next Resume passes the window check, and the
  // server's divergence detection emits admin_reissue for any live
  // credentials. Treating this as fatal here would kill the daemon and
  // force the user to re-run `/spellguard-setup` for a recoverable
  // condition.
]);
var AgentControlClient = class {
  constructor(opts) {
    this.opts = opts;
    this.#lastServerSeq = opts.initialLastServerSeq ?? "0";
    this.#knownCredentials = opts.initialKnownCredentials ?? [];
  }
  opts;
  #ps = null;
  /** Preserve wire order across async receiver durability hooks. */
  #messageChain = Promise.resolve();
  #closed = false;
  #lastServerSeq;
  #knownCredentials;
  /** True only for a connection whose query advertised `resume=always`. */
  #resumeAlwaysConnection = false;
  #firstConnect = true;
  #pendingRequests = /* @__PURE__ */ new Map();
  // Serializes refresh requests because `credential_delivered` carries no
  // `client_msg_id` correlation: with two requests in flight, the dispatcher
  // would resolve them out-of-order. This serialization can be dropped if the
  // protocol later grows an `in_response_to` correlation field.
  #refreshChain = Promise.resolve();
  // Redacted replay and the following divergence pass can announce the same
  // issued identity before its first refresh completes. Keep one refresh per
  // identity in flight so the second notice cannot rotate it again after the
  // first response settles.
  #redactedRefreshesInFlight = /* @__PURE__ */ new Set();
  // Rotation-fallback timers. Key = seq of the config_updated frame.
  // Cleared when a credential_rotated arrives before the 10s window expires.
  #rotationTimers = /* @__PURE__ */ new Map();
  // FIND-DA22 — keepalive heartbeat state. The timer fires every
  // heartbeatIntervalMs; #lastPongAt tracks the last observed 'pong' (clock
  // value, via the injectable #now()) so the timer can detect a zombie socket.
  #heartbeatTimer = null;
  #lastPongAt = 0;
  /** Consecutive HTTP-upgrade auth failures seen before a socket opens. */
  #consecutiveUpgradeAuthFailures = 0;
  /**
   * #1348: the last suspended (4423) wait, or null while the session is
   * healthy. A suspended reconnect still opens (hello, then 4423), so this
   * resets only on a frame past the hello, never on `open`.
   */
  #suspendedDelayMs = null;
  #suspendedTimer = null;
  /** Open the socket. Subsequent reconnects are automatic. */
  start() {
    if (this.#closed || this.#ps) return;
    const BaseImpl = this.opts.WebSocketImpl ?? wrapper_default;
    const Impl = makeErrorSafeWebSocket(
      BaseImpl,
      this.opts.upgradeHeaders,
      (err) => this.#observeUpgradeError(err)
    );
    const apiBaseUrl = this.opts.apiBaseUrl.replace(/^https?:\/\//, "");
    const tls = this.opts.apiBaseUrl.startsWith("https://");
    const ps = new PartySocket({
      host: apiBaseUrl,
      protocol: tls ? "wss" : "ws",
      // basePath overrides partysocket's default `${prefix}/${party}/${room}`
      // path so the URL exactly matches our route mount
      // `/v1/agent-control/channel/:agent_id`. Must not start with a slash —
      // partysocket inserts the leading `/` between host and basePath.
      basePath: `v1/agent-control/channel/${this.opts.agentId}`,
      // Async URL provider — partysocket calls this on every reconnect
      // attempt, so freshly-rotated nonce-mode params reach the wire.
      // agent_secret is carried in the subprotocol header, not the URL
      // query, so secret-mode connections leave this empty.
      query: async () => this.#buildQuery(),
      // Secret-mode auth flows through Sec-WebSocket-Protocol. partysocket
      // calls this on every reconnect, so a rotated secret (after admin
      // rotation) reaches the wire on the next attempt.
      protocols: async () => this.#buildProtocols(),
      maxRetries: Number.POSITIVE_INFINITY,
      // Cap the backoff to keep reconnects responsive after long
      // hibernation windows.
      maxReconnectionDelay: this.opts.maxReconnectionDelayMs ?? 3e4,
      // FIND-DA24 — override partysocket's 4s default connectionTimeout. The
      // agent-control WS upgrade (cold DB lookup + bcrypt verify + DO
      // cold-start) routinely takes ~2–4s; a 4s abort-and-retry loop on a
      // slow-but-succeeding handshake is the root cause of the login-relay
      // connection flap. 20s default headroom; injectable via opts.
      connectionTimeout: this.opts.connectionTimeoutMs ?? 2e4,
      // Use the `ws` library on Node — partysocket's default targets
      // browsers.
      WebSocket: Impl
    });
    this.#ps = ps;
    ps.addEventListener("open", () => {
      this.#consecutiveUpgradeAuthFailures = 0;
      void this.#onOpen();
    });
    ps.addEventListener("message", (e) => {
      this.#messageChain = this.#messageChain.then(
        () => this.#handleMessage(e)
      );
    });
    ps.addEventListener("close", (event) => {
      this.#stopHeartbeat();
      const closeEvent = event;
      const code = closeEvent.code ?? 0;
      const reason = closeEvent.reason ?? "";
      if (code === AGENT_CONTROL_CLOSE_CODES.AUTH_SUPERSEDED) {
        const validReasons = new Set(
          Object.values(AUTH_SUPERSEDED_CLOSE_REASONS)
        );
        const cause = validReasons.has(
          reason
        ) ? reason : void 0;
        this.opts.onCredentialSuperseded?.(cause);
        this.close();
        return;
      }
      if (code === AGENT_CONTROL_CLOSE_CODES.AGENT_SUSPENDED) {
        this.#suspend(reason);
        return;
      }
      if (FATAL_CLOSE_CODES.has(code)) {
        this.opts.onFatalClose(code, reason);
        this.close();
      }
    });
    ps.addEventListener("error", (event) => {
      const wrapped = event;
      const err = event instanceof Error ? event : wrapped.error instanceof Error ? wrapped.error : new Error(
        `socket error: ${typeof wrapped.message === "string" && wrapped.message ? wrapped.message : String(event)}`
      );
      this.opts.onError?.(err);
    });
  }
  /**
   * #1348: the agent is quarantined. PartySocket has already queued its own
   * quick retry (its close handler reconnects before listeners run), so stop
   * it and reconnect on the suspended backoff instead. Identity stays.
   */
  #suspend(reason) {
    const ps = this.#ps;
    if (this.#closed || !ps) return;
    ps.close();
    const { initial, max } = this.opts.suspendedBackoffMs ?? {
      initial: 3e4,
      max: 3e5
    };
    const retryInMs = this.#suspendedDelayMs === null ? initial : Math.min(this.#suspendedDelayMs * 2, max);
    this.#suspendedDelayMs = retryInMs;
    if (this.#suspendedTimer) clearTimeout(this.#suspendedTimer);
    this.#suspendedTimer = setTimeout(() => {
      this.#suspendedTimer = null;
      if (!this.#closed && this.#ps === ps) ps.reconnect();
    }, retryInMs);
    this.#knownCredentials = [];
    void Promise.resolve().then(() => this.opts.onKnownCredentialsChanged?.([])).then(() => this.opts.onSuspended?.({ reason, retryInMs })).catch(
      (err) => this.opts.onError?.(
        err instanceof Error ? err : new Error(String(err))
      )
    );
  }
  #observeUpgradeError(err) {
    if (isUpgradeUnauthorized(err)) {
      this.#consecutiveUpgradeAuthFailures += 1;
      if (this.#consecutiveUpgradeAuthFailures >= 3) {
        this.opts.onFatalClose(
          AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED,
          "http_upgrade_unauthorized"
        );
        this.close();
      }
      return;
    }
    this.#consecutiveUpgradeAuthFailures = 0;
  }
  /** Send a CredentialRequest and resolve after the durable response apply.
   *  V4 returns delivered descriptors; V5 resolves `[]` after its bundle hook
   *  commits. Times out if no matching response arrives within `timeoutMs`. */
  async requestRefresh(args, opts = {}) {
    if (!this.#ps) throw new Error("client not started");
    const next = this.#refreshChain.catch(() => void 0).then(() => this.#sendRefresh(args, opts));
    this.#refreshChain = next;
    return next;
  }
  async #sendRefresh(args, opts) {
    if (this.#closed) throw new Error("client_closed");
    if (!this.#ps) throw new Error("client not started");
    const clientMsgId = crypto.randomUUID();
    const timeoutMs = opts.timeoutMs ?? 3e4;
    return await new Promise((resolve4, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(clientMsgId);
        reject(new Error("credential_request_timeout"));
      }, timeoutMs);
      this.#pendingRequests.set(clientMsgId, {
        resolve: resolve4,
        reject,
        timer,
        requestedProvider: args.provider,
        requestedReason: args.reason,
        // Carry the superseded id so the resolution path can prune it from
        // knownCredentials when the new credential is delivered.
        supersededProvider: args.provider,
        supersededScopedTokenId: args.superseded_scoped_token_id
      });
      this.#ps?.send(
        JSON.stringify({
          type: "credential_request",
          client_msg_id: clientMsgId,
          reason: args.reason,
          provider: args.provider,
          ...args.superseded_scoped_token_id ? {
            superseded_scoped_token_id: args.superseded_scoped_token_id
          } : {}
        })
      );
    });
  }
  /**
   * Fire-and-forget signal that the bot's inbound platform socket
   * (Slack/Teams/Discord) is up and it can actually reply. Sends a
   * `channel_ready` ClientFrame — the server persists `agents.channel_ready_at`
   * on first receipt and Acks via the existing `AckFrame`.
   *
   * This mirrors the inline `bootstrap_request`/`resume` send shape: it is
   * NOT routed through `#refreshChain` or the `#pendingRequests` map (there
   * is nothing to correlate — the server's Ack is observed by the existing
   * `case 'ack'` dispatcher and harmlessly ignored when no pending entry
   * matches). Guarded on `#ps` existing and `!#closed` so a call while the
   * agent-control socket is mid-reconnect/closed is a silent no-op (the
   * caller re-triggers on the next readiness event).
   */
  sendChannelReady(args) {
    if (this.#closed || !this.#ps) return;
    try {
      this.#ps.send(
        JSON.stringify({
          type: "channel_ready",
          client_msg_id: crypto.randomUUID(),
          ...args.reason ? { reason: args.reason } : {},
          ...args.platform ? { platform: args.platform } : {},
          ...args.metadata ? { metadata: args.metadata } : {}
        })
      );
    } catch {
    }
  }
  /**
   * REQ-003 (Task 17) — Fire-and-forget notification that the box's
   * headless login-relay state has changed. Sends a `login_relay_update`
   * ClientFrame up the control channel so the dashboard/broker can surface
   * the URL to the operator or record the outcome.
   *
   * NEG-001: this method accepts ONLY state/url/message — it carries NO
   * token, no code, and no secret material. The token stays on-box.
   *
   * Mirrors `sendChannelReady`: fire-and-forget, not routed through
   * `#refreshChain`, guarded on `#ps` + `!#closed` (silent no-op when the
   * socket is mid-reconnect).
   */
  sendLoginRelayUpdate(update) {
    if (this.#closed || !this.#ps) return;
    try {
      this.#ps.send(
        JSON.stringify({
          type: "login_relay_update",
          client_msg_id: crypto.randomUUID(),
          state: update.state,
          ...update.login_url ? { login_url: update.login_url } : {},
          ...update.message ? { message: update.message } : {},
          // T4.3 — carry the per-frame framework discriminator when the caller
          // (the multiplexed Go box daemon) supplies it. Omitted for the
          // single-framework Node daemon path so its frame stays byte-identical.
          ...update.framework ? { framework: update.framework } : {}
        })
      );
    } catch {
    }
  }
  /** Close the socket and stop reconnecting. */
  close() {
    this.#closed = true;
    if (this.#suspendedTimer) clearTimeout(this.#suspendedTimer);
    this.#suspendedTimer = null;
    this.#stopHeartbeat();
    for (const [, p] of this.#pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error("client_closed"));
    }
    this.#pendingRequests.clear();
    for (const [, t] of this.#rotationTimers) clearTimeout(t);
    this.#rotationTimers.clear();
    try {
      this.#ps?.close();
    } catch {
    }
    this.#ps = null;
  }
  // ── internals ────────────────────────────────────────────────────────────
  /** Injectable monotonic-enough clock. Defaults to wall time. */
  #now() {
    return (this.opts.now ?? Date.now)();
  }
  /**
   * FIND-DA22 — start the application-level keepalive heartbeat.
   *
   * Called from `#onOpen` (a fresh socket starts the heartbeat). Sends a bare
   * `'ping'` every `heartbeatIntervalMs` and watches for the matching `'pong'`
   * (tracked in `#lastPongAt`). If a full interval+grace passes with no pong,
   * the socket is a zombie (the reconnect logic can't see it) and we force
   * `partysocket.reconnect()` ourselves. Stopped on every disconnect via
   * `#stopHeartbeat` and restarted by the next `#onOpen`.
   */
  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#lastPongAt = this.#now();
    const intervalMs = this.opts.heartbeatIntervalMs ?? 25e3;
    const timeoutMs = this.opts.heartbeatTimeoutMs ?? 1e4;
    this.#heartbeatTimer = setInterval(() => {
      if (this.#closed || !this.#ps) return;
      if (this.#now() - this.#lastPongAt > intervalMs + timeoutMs) {
        this.#ps.reconnect();
        return;
      }
      try {
        this.#ps.send("ping");
      } catch {
      }
    }, intervalMs);
  }
  /** Stop the heartbeat timer (idempotent). */
  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }
  /**
   * REQ-010 — write the local "channel-ready" coordination marker once the
   * agent-control channel is established, but ONLY on a managed box: gated on
   * the `SPELLGUARD_CHANNEL_READY_MARKER` env var, which the Go managed-bootstrap
   * authors into the daemon's systemd unit (`internal/boxinstall/systemd.go`).
   * The Go orchestrator's no-false-online gate (`WaitForDaemonChannelReady`)
   * polls that exact path before running the authenticated git self-check; if
   * nothing writes it the gate times out (`daemon_channel_timeout`) on a real
   * box. Reading the path from the env (rather than re-deriving it in TS)
   * eliminates any TS-vs-Go path-derivation drift.
   *
   * This is a pure coordination signal — NOT a credential and NOT crypto. The
   * payload is a throwaway ISO timestamp. Best-effort by contract: when the env
   * var is unset (every non-managed/local consumer) it touches no filesystem,
   * and any fs error is routed to the logging hook and swallowed so a failed
   * marker write can never crash the daemon.
   */
  async #writeChannelReadyMarker() {
    const markerPath = process.env.SPELLGUARD_CHANNEL_READY_MARKER;
    if (!markerPath) return;
    try {
      await mkdir(dirname(markerPath), { recursive: true });
      await writeFile(markerPath, `${(/* @__PURE__ */ new Date()).toISOString()}
`, "utf8");
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
  /**
   * #1348: the Resume capabilities. AGENT_SUSPEND_CAPABILITY is added only
   * when the plugin wired `onSuspended`, since only then does a suspension
   * drop what it placed; a client that can't must keep getting 4401.
   */
  #resumeCapabilities() {
    if (!this.opts.onSuspended) return this.opts.capabilities;
    return [...this.opts.capabilities ?? [], AGENT_SUSPEND_CAPABILITY];
  }
  async #buildQuery() {
    const creds = await this.opts.credentials();
    if (creds.mode === "secret") {
      this.#resumeAlwaysConnection = true;
      return {
        agent_secret: creds.agentSecret,
        resume: "always",
        ...creds.framework ? { framework: creds.framework } : {},
        ...this.opts.onSuspended ? { suspend: "1" } : {}
      };
    }
    this.#resumeAlwaysConnection = false;
    if (creds.mode === "managed-bootstrap") {
      return { nonce: creds.nonce };
    }
    return {
      nonce: creds.nonce,
      ct: creds.channelToken,
      orgId: creds.orgId,
      ...creds.agentName ? { agent_name: creds.agentName } : {}
    };
  }
  /**
   * Build the Sec-WebSocket-Protocol header value for secret-mode auth.
   * Format: `[<version>, agent-secret.<plaintext>]`. The server reads the
   * agent-secret protocol entry, validates it against the stored hashed
   * agent secret (with grace-window fallback), and does NOT echo a
   * subprotocol in the 101 response — the `ws` library accepts the connection
   * without subprotocol negotiation when the response omits the header.
   *
   * Returns `null` for nonce mode so partysocket sends no Sec-WebSocket-Protocol
   * header at all on first-run bootstrap.
   */
  async #buildProtocols() {
    const creds = await this.opts.credentials();
    if (creds.mode !== "secret") return null;
    return null;
  }
  async #onOpen() {
    if (!this.#ps) return;
    this.#lastPongAt = this.#now();
    this.#startHeartbeat();
    try {
      const r = this.opts.onConnect?.();
      if (r && typeof r.catch === "function") {
        r.catch((err) => {
          this.opts.onError?.(
            err instanceof Error ? err : new Error(String(err))
          );
        });
      }
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
    void this.#writeChannelReadyMarker();
    let creds;
    try {
      creds = await this.opts.credentials();
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (creds.mode === "managed-bootstrap") {
      this.#firstConnect = false;
      return;
    }
    const noStateYet = this.#lastServerSeq === "0" && this.#knownCredentials.length === 0;
    if (creds.mode === "nonce" && noStateYet && !creds.expectReBootstrap) {
      this.#firstConnect = false;
      if (!creds.agentName) {
        this.opts.onError?.(
          new Error(
            "agent-control: agent_name is required for bootstrap_request but was not provided by the credentials accessor. Ensure the caller passes agentName when starting in nonce mode."
          )
        );
        return;
      }
      this.#ps.send(
        JSON.stringify({
          type: "bootstrap_request",
          client_msg_id: crypto.randomUUID(),
          nonce: creds.nonce,
          agent_name: creds.agentName,
          ...creds.statementOfReason ? { statement_of_reason: creds.statementOfReason } : {},
          ...creds.framework ? { framework: creds.framework } : {}
        })
      );
      return;
    }
    this.#firstConnect = false;
  }
  /**
   * Send the Resume frame after Hello has been received and any
   * fresh-channel reset has been applied. Returns void; called from
   * `case 'hello'`.
   */
  #sendResumeIfApplicable() {
    if (!this.#ps || !this.#resumeAlwaysConnection) return;
    this.#ps.send(
      JSON.stringify({
        type: "resume",
        client_msg_id: crypto.randomUUID(),
        last_server_seq: this.#lastServerSeq,
        known_credentials: this.#knownCredentials,
        capabilities: this.#resumeCapabilities()
      })
    );
  }
  async #handleMessage(e) {
    const text = typeof e.data === "string" ? e.data : e.data.toString("utf-8");
    if (text === "pong") {
      this.#lastPongAt = this.#now();
      return;
    }
    const frame = parseServerFrame(text);
    if (frame === null) {
      this.opts.onError?.(
        new Error("agent-control: rejected malformed or unknown frame")
      );
      return;
    }
    if (frame.type !== "hello") this.#suspendedDelayMs = null;
    try {
      await this.#dispatch(frame);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
  /**
   * A V5 bundle is a complete authoritative GitHub set but carries no request
   * correlation id. Refresh requests are serialized, so at most one pending
   * request can match. A scoped refresh is satisfied only when the full set no
   * longer contains the superseded id; an unscoped manual issuance is
   * satisfied only by a secret-bearing set. The caller invokes this strictly
   * after the receiver's durable apply hook succeeds.
   */
  #settlePendingGithubGrantBundle(frame) {
    const activeIds = new Set(
      frame.credentials.map((credential) => credential.scoped_token_id)
    );
    for (const [id, pending] of this.#pendingRequests) {
      if (pending.requestedProvider !== "github") continue;
      const matches = pending.supersededScopedTokenId ? !activeIds.has(pending.supersededScopedTokenId) : pending.requestedReason === "manual" && frame.credentials.length > 0;
      if (!matches) continue;
      clearTimeout(pending.timer);
      if (pending.supersededScopedTokenId) {
        this.#dropKnownCredential(
          pending.supersededProvider,
          pending.supersededScopedTokenId
        );
      }
      pending.resolve([]);
      this.#pendingRequests.delete(id);
      break;
    }
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pure protocol-frame dispatcher; each case is a leaf delegating to a typed handler. Splitting per-case would scatter the seq-advancement / pending-resolution invariants this method enforces in one place.
  async #dispatch(frame) {
    switch (frame.type) {
      case "hello": {
        const hasStaleState = this.#lastServerSeq !== "0" || this.#knownCredentials.length > 0;
        if (frame.is_fresh_channel && hasStaleState) {
          this.opts.onError?.(
            new Error(
              `agent-control: server signaled fresh channel; resetting cursor (was=${this.#lastServerSeq}, server=${frame.current_seq})`
            )
          );
          const preResetKnown = this.#knownCredentials;
          this.#lastServerSeq = "0";
          this.#knownCredentials = [];
          await this.opts.onSeqAdvanced("0");
          await this.opts.onKnownCredentialsChanged?.([]);
          if (this.#ps && this.#resumeAlwaysConnection) {
            this.#ps.send(
              JSON.stringify({
                type: "resume",
                client_msg_id: crypto.randomUUID(),
                last_server_seq: "0",
                known_credentials: preResetKnown,
                capabilities: this.#resumeCapabilities()
              })
            );
          }
          return;
        }
        this.#sendResumeIfApplicable();
        return;
      }
      case "github_grants_bundle": {
        try {
          if (!this.opts.onGithubGrantsBundle) {
            throw new Error("github_grant_bundle_v1 handler is unavailable");
          }
          await this.opts.onGithubGrantsBundle(frame);
          this.#settlePendingGithubGrantBundle(frame);
          this.#ps?.send(
            JSON.stringify({
              type: "github_grants_applied",
              protocol_version: "5",
              client_msg_id: crypto.randomUUID(),
              delivery_id: frame.delivery_id,
              grant_set_revision: frame.grant_set_revision,
              applied: true
            })
          );
          await this.#advanceSeq(frame.seq);
        } catch (error) {
          this.#ps?.send(
            JSON.stringify({
              type: "github_grants_applied",
              protocol_version: "5",
              client_msg_id: crypto.randomUUID(),
              delivery_id: frame.delivery_id,
              grant_set_revision: frame.grant_set_revision,
              applied: false,
              error_code: "durable_apply_failed"
            })
          );
          throw error;
        }
        return;
      }
      case "github_grants_commit_confirmed":
        await this.opts.onGithubGrantsCommitConfirmed?.(frame);
        await this.#advanceSeq(frame.seq);
        return;
      case "credential_delivered": {
        const isBootstrapCause = frame.cause === "bootstrap" || frame.cause === "re_bootstrap";
        const incomplete = this.#incompleteCredentials(frame.credentials);
        if (!isBootstrapCause && await this.#handleIfIncomplete(
          frame.credentials,
          frame.seq,
          `credential_delivered{cause:'${frame.cause}'}`
        )) {
          return;
        }
        if (isBootstrapCause && incomplete.length > 0) {
          await this.#dropIncompleteKnownCredentials(incomplete);
        }
        const usableCredentials = incomplete.length > 0 ? frame.credentials.filter(
          (credential) => this.#credentialCarriesUsableSecret(credential)
        ) : frame.credentials;
        await this.opts.onCredentialDelivered(
          usableCredentials === frame.credentials ? frame : { ...frame, credentials: usableCredentials }
        );
        this.#trackKnownCredentials(usableCredentials);
        await this.#advanceSeq(frame.seq);
        if (isBootstrapCause) {
          this.#queueRefreshForBareIssued(frame.credentials);
          if (incomplete.some((credential) => credential.provider !== "github")) {
            this.#reportIncomplete(
              `credential_delivered{cause:'${frame.cause}'}`
            );
          }
        }
        if (frame.cause === "refresh_response" || frame.cause === "admin_reissue") {
          for (const [id, p] of this.#pendingRequests) {
            clearTimeout(p.timer);
            if (p.supersededScopedTokenId) {
              this.#dropKnownCredential(
                p.supersededProvider,
                p.supersededScopedTokenId
              );
            }
            p.resolve(frame.credentials);
            this.#pendingRequests.delete(id);
            break;
          }
        }
        return;
      }
      case "credential_rotated": {
        for (const [seq, t] of this.#rotationTimers) {
          clearTimeout(t);
          this.#rotationTimers.delete(seq);
        }
        const superseded = frame.superseded_scoped_token_id;
        if (await this.#handleIfIncomplete(
          frame.credentials,
          frame.seq,
          "credential_rotated",
          superseded
        )) {
          return;
        }
        await this.opts.onCredentialRotated?.(frame);
        if (superseded) {
          const supersededProvider = frame.credentials[0]?.provider;
          this.#dropKnownCredential(supersededProvider, superseded);
        }
        this.#trackKnownCredentials(frame.credentials);
        await this.#advanceSeq(frame.seq);
        for (const [id, p] of this.#pendingRequests) {
          clearTimeout(p.timer);
          if (p.supersededScopedTokenId) {
            this.#dropKnownCredential(
              p.supersededProvider,
              p.supersededScopedTokenId
            );
          }
          p.resolve(frame.credentials);
          this.#pendingRequests.delete(id);
          break;
        }
        return;
      }
      case "credential_revoked": {
        await this.opts.onCredentialRevoked?.(frame);
        const beforeRevoke = this.#knownCredentials.length;
        this.#knownCredentials = this.#knownCredentials.filter(
          (k) => !(k.provider === frame.provider && k.scoped_token_id === frame.scoped_token_id)
        );
        if (this.#knownCredentials.length !== beforeRevoke) {
          await this.opts.onKnownCredentialsChanged?.(this.#knownCredentials);
        }
        await this.#advanceSeq(frame.seq);
        await this.opts.onCredentialRevokeSettled?.(frame);
        return;
      }
      case "config_updated": {
        await this.opts.onConfigUpdated?.(frame);
        await this.#advanceSeq(frame.seq);
        if (frame.triggers_rotation) {
          const seq = frame.seq;
          const rotationMs = this.opts.rotationFallbackTimeoutMs ?? 1e4;
          const timer = setTimeout(() => {
            this.#rotationTimers.delete(seq);
            const known = this.#knownCredentials.filter(
              (k) => k.provider === frame.config.provider
            );
            for (const k of known.length > 0 ? known : [void 0]) {
              void this.requestRefresh({
                reason: "manual",
                provider: frame.config.provider,
                superseded_scoped_token_id: k?.scoped_token_id
              }).catch((err) => {
                if (err instanceof Error && err.message === "client_closed")
                  return;
                this.opts.onError?.(
                  err instanceof Error ? err : new Error(String(err))
                );
              });
            }
          }, rotationMs);
          this.#rotationTimers.set(seq, timer);
        }
        return;
      }
      case "ack": {
        const pending = this.#pendingRequests.get(frame.client_msg_id);
        if (pending) {
          if (!frame.ok) {
            clearTimeout(pending.timer);
            pending.reject(
              new Error(
                `${frame.error_code ?? "unknown"}: ${frame.error_message ?? ""}`
              )
            );
            this.#pendingRequests.delete(frame.client_msg_id);
          }
        }
        await this.#advanceSeq(frame.seq);
        return;
      }
      case "error": {
        for (const [id, p] of this.#pendingRequests) {
          clearTimeout(p.timer);
          p.reject(new Error(`${frame.code}: ${frame.message}`));
          this.#pendingRequests.delete(id);
          break;
        }
        this.opts.onError?.(
          new Error(`server: ${frame.code}: ${frame.message}`)
        );
        await this.#advanceSeq(frame.seq);
        return;
      }
      case "resume_window_exceeded": {
        this.#lastServerSeq = frame.current_seq;
        this.#knownCredentials = [];
        await this.opts.onSeqAdvanced(frame.current_seq);
        await this.opts.onKnownCredentialsChanged?.([]);
        this.opts.onError?.(
          new Error(
            `agent-control: server signaled resume_window_exceeded; cursor fast-forwarded to seq=${frame.current_seq}; reconnecting`
          )
        );
        return;
      }
      case "login_code": {
        await this.opts.onLoginCode?.(frame);
        return;
      }
      case "login_restart": {
        await this.opts.onLoginRestart?.(frame);
        return;
      }
      case "slack_event":
      case "slack_event_blocked":
      case "teams_activity":
      case "teams_activity_blocked": {
        this.#dispatchRelayFrame(frame);
        return;
      }
    }
  }
  /**
   * Fire-and-forget invocation of the relay-event handler. NEVER awaited on the
   * dispatch path (R5): a synchronous throw is caught, and a returned rejecting
   * promise gets a `.catch` — both route to `onError`, never to the socket or
   * the seq cursor. No-op when `onRelayEvent` is unwired (relay frame ignored).
   */
  #dispatchRelayFrame(frame) {
    const handler = this.opts.onRelayEvent;
    if (!handler) return;
    try {
      const r = handler(frame);
      if (r && typeof r.catch === "function") {
        r.catch((err) => {
          this.opts.onError?.(
            err instanceof Error ? err : new Error(String(err))
          );
        });
      }
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
  /**
   * Settle a frame containing a provider-incomplete descriptor. Ring replay
   * strips GitHub `scoped_token`, Slack/Discord `botToken`, Teams `password`,
   * and OpenRouter `api_key`. Remove any prior projection entry durably, leave
   * the consuming destination untouched, advance the replay cursor, and queue
   * refresh only for the issued GitHub path.
   */
  async #handleIfIncomplete(creds, seq, logLabel, supersededId) {
    const incomplete = this.#incompleteCredentials(creds);
    if (incomplete.length === 0) return false;
    await this.#dropIncompleteKnownCredentials(incomplete);
    await this.#advanceSeq(seq);
    this.#reportIncomplete(logLabel);
    this.#queueRefreshForBareIssued(creds, supersededId);
    return true;
  }
  #credentialCarriesUsableSecret(credential) {
    const raw = credential;
    switch (credential.provider) {
      case "github":
        return typeof raw.scoped_token === "string" && raw.scoped_token.length > 0;
      case "slack":
      case "discord":
        return typeof raw.botToken === "string" && raw.botToken.length > 0;
      case "teams":
        return typeof raw.password === "string" && raw.password.length > 0;
      case "openrouter":
        return typeof raw.api_key === "string" && raw.api_key.length > 0;
      default:
        return true;
    }
  }
  #incompleteCredentials(credentials) {
    return credentials.filter(
      (credential) => !this.#credentialCarriesUsableSecret(credential)
    );
  }
  async #dropIncompleteKnownCredentials(credentials) {
    const identities = new Set(
      credentials.map((credential) => {
        const raw = credential;
        const id = raw.scoped_token_id ?? credential.credential_id;
        return `${credential.provider}\0${String(id)}`;
      })
    );
    const next = this.#knownCredentials.filter(
      (known) => !identities.has(`${known.provider}\0${known.scoped_token_id}`)
    );
    if (next.length === this.#knownCredentials.length) return;
    this.#knownCredentials = next;
    await this.opts.onKnownCredentialsChanged?.(this.#knownCredentials);
  }
  #reportIncomplete(logLabel) {
    const notice = `agent-control: redacted/replay-incomplete ${logLabel} \u2014 preserving existing credential and awaiting authoritative hydration`;
    if (this.opts.onInfo) {
      this.opts.onInfo(notice);
    } else {
      this.opts.onError?.(new Error(notice));
    }
  }
  /**
   * Queue a fire-and-forget `credential_request` for each ISSUED (github)
   * credential that arrived WITHOUT a `scoped_token`. Shared by the
   * redacted-replay path (`#handleIfIncomplete`) and the bootstrap/re_bootstrap
   * delivery path (where the descriptor is bare by design — see the C11 note
   * in `case 'credential_delivered'`). #refreshChain serializes concurrent
   * requests; `client_closed` / `client not started` rejections on teardown
   * are swallowed (a one-shot setup client closes right after settling, and the
   * daemon recovers the token via the steady-state divergence path).
   */
  #queueRefreshForBareIssued(creds, supersededId) {
    if (this.#closed || !this.#ps) return;
    for (const c of creds) {
      const effKind = c.kind ?? (c.provider === "github" ? "issued" : c.kind);
      if (effKind !== "issued") continue;
      const issued = c;
      if (issued.scoped_token) continue;
      const identity = supersededId ?? issued.scoped_token_id ?? issued.credential_id;
      const refreshKey = `${issued.provider}\0${identity}`;
      if (this.#redactedRefreshesInFlight.has(refreshKey)) continue;
      this.#redactedRefreshesInFlight.add(refreshKey);
      void this.requestRefresh({
        reason: "expiry",
        provider: issued.provider,
        superseded_scoped_token_id: identity
      }).catch((err) => {
        if (err instanceof Error && (err.message === "client_closed" || err.message === "client not started")) {
          return;
        }
        this.opts.onError?.(
          err instanceof Error ? err : new Error(String(err))
        );
      }).finally(() => {
        this.#redactedRefreshesInFlight.delete(refreshKey);
      });
    }
  }
  /**
   * Drop a single (provider, scoped_token_id) entry. Called from the
   * credential_rotated dispatch path before #trackKnownCredentials adds
   * the new entry, so the projection stays in lockstep with the server's
   * live row set across rotations.
   */
  #dropKnownCredential(provider, scopedTokenId) {
    const before = this.#knownCredentials.length;
    this.#knownCredentials = this.#knownCredentials.filter(
      (k) => !((provider === void 0 || k.provider === provider) && k.scoped_token_id === scopedTokenId)
    );
    if (this.#knownCredentials.length !== before) {
      void this.opts.onKnownCredentialsChanged?.(this.#knownCredentials);
    }
  }
  #trackKnownCredentials(creds) {
    const next = [...this.#knownCredentials];
    let changed = false;
    for (const c of creds) {
      const effKind = c.kind ?? (c.provider === "github" ? "issued" : c.kind);
      const trackingId = effKind === "issued" ? c.scoped_token_id ?? c.credential_id : c.credential_id;
      const idx = next.findIndex(
        (k) => k.provider === c.provider && k.scoped_token_id === trackingId
      );
      if (idx === -1) {
        next.push({ provider: c.provider, scoped_token_id: trackingId });
        changed = true;
      }
    }
    this.#knownCredentials = next;
    if (changed) {
      void this.opts.onKnownCredentialsChanged?.(this.#knownCredentials);
    }
  }
  async #advanceSeq(seq) {
    let nextN;
    let currentN;
    try {
      nextN = BigInt(seq);
      currentN = BigInt(this.#lastServerSeq);
    } catch {
      this.opts.onError?.(
        new Error(`agent-control: invalid seq value: ${String(seq)}`)
      );
      return;
    }
    if (nextN <= currentN) return;
    this.#lastServerSeq = seq;
    await this.opts.onSeqAdvanced(seq);
    try {
      this.#ps?.send(
        JSON.stringify({
          type: "ack",
          client_msg_id: crypto.randomUUID(),
          acked_seq: seq
        })
      );
    } catch {
    }
  }
};
function upgradeStatusOf(err) {
  if (typeof err !== "object" || err === null) return void 0;
  const e = err;
  for (const candidate of [
    e.statusCode,
    e.status,
    e.response?.statusCode,
    e.response?.status
  ]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return void 0;
}
function isUpgradeUnauthorized(err) {
  const status = upgradeStatusOf(err);
  if (status !== void 0) return status === 401;
  const message = typeof err === "object" && err !== null && "message" in err ? String(err.message ?? "") : String(err ?? "");
  return /\b(?:http|status(?:\s+code)?|code|response|upgrade|connection)\b[\s:=]*401\b/i.test(
    message
  ) || /\b401\s+unauthorized\b/i.test(message);
}
function makeErrorSafeWebSocket(Base, headers, onUpgradeError) {
  function Wrapped(url, protocols) {
    const ws = headers ? (
      // biome-ignore lint/suspicious/noExplicitAny: bridging to ws (url, protocols, options) signature (see above).
      new Base(url, protocols, { headers })
    ) : (
      // biome-ignore lint/suspicious/noExplicitAny: bridging to ws (url, protocols) signature (see above).
      new Base(url, protocols)
    );
    const observe = (value) => {
      const wrapped = value;
      const err = value instanceof Error ? value : wrapped.error instanceof Error ? wrapped.error : new Error(
        typeof wrapped.message === "string" ? wrapped.message : String(value)
      );
      onUpgradeError?.(err);
    };
    if (ws && typeof ws.on === "function") {
      ws.on("error", observe);
    } else if (ws && typeof ws.addEventListener === "function") {
      ws.addEventListener("error", observe);
    }
    return ws;
  }
  Wrapped.prototype = Base.prototype;
  return Wrapped;
}
function normalizeManagementBaseUrl(baseUrl) {
  let url = baseUrl;
  while (url.endsWith("/")) url = url.slice(0, -1);
  if (url.endsWith("/v1")) url = url.slice(0, -3);
  return url;
}
var USER_AGENT = "spellguard-plugin/0.1.0";
function createManagementClient(opts) {
  const baseFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const retryDelay = opts.retryDelayMs ?? 1e3;
  const retryOn5xx = opts.retry ?? true;
  const retryingFetch = (async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    if (!retryOn5xx) return baseFetch(req);
    const first = await baseFetch(req.clone());
    if (first.status >= 500) {
      await new Promise((resolve4) => setTimeout(resolve4, retryDelay));
      return baseFetch(req);
    }
    return first;
  });
  const auth = {
    onRequest({ request }) {
      if ((opts.auth ?? "agent-secret") === "bearer") {
        request.headers.set("Authorization", `Bearer ${opts.agentSecret}`);
      } else {
        request.headers.set("X-Spellguard-Agent-Id", opts.agentId);
        request.headers.set("X-Spellguard-Agent-Secret", opts.agentSecret);
      }
      request.headers.set("User-Agent", USER_AGENT);
      return request;
    }
  };
  const client = createClient({
    // Strip a trailing slash AND a trailing `/v1` before appending `/v1`, so a
    // baseUrl of either `https://host` or `https://host/v1` (OpenClaw's docker
    // default carries `/v1`) yields a single `/v1`, never `/v1/v1`.
    baseUrl: `${normalizeManagementBaseUrl(opts.baseUrl)}/v1`,
    fetch: retryingFetch
  });
  client.use(auth);
  return client;
}
var MANAGED_MARKER_BASENAME = ".managed";
function spellguardRootDir(env = process.env, home = homedir()) {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "spellguard") : join(home, ".config", "spellguard");
}
function managedMarkerPath(root = spellguardRootDir()) {
  return join(root, MANAGED_MARKER_BASENAME);
}
function readManagedMarker(root = spellguardRootDir()) {
  const path = managedMarkerPath(root);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const e = err;
    if (e.code === "ENOENT") return { managed: false };
    return {
      managed: false,
      diagnostic: `managed marker unreadable at ${path}: ${e.message}`
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      managed: false,
      diagnostic: `managed marker corrupt at ${path}: ${err.message}`
    };
  }
  const marker = parsed;
  if (!marker || typeof marker !== "object" || typeof marker.agent_id !== "string" || marker.agent_id === "") {
    return {
      managed: false,
      diagnostic: `managed marker at ${path} missing agent_id`
    };
  }
  let stats;
  try {
    stats = statSync(path);
  } catch (err) {
    return {
      managed: false,
      diagnostic: `managed marker unstatable at ${path}: ${err.message}`
    };
  }
  const perm = stats.mode & 511;
  if (perm & 18) {
    return {
      managed: false,
      diagnostic: `managed marker at ${path} is group/world-writable (mode ${perm.toString(8)}); refusing to honor`
    };
  }
  const readerUid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (readerUid !== void 0 && readerUid !== 0 && typeof stats.uid === "number" && stats.uid !== 0 && stats.uid !== readerUid) {
    return {
      managed: false,
      diagnostic: `managed marker at ${path} owned by untrusted uid ${stats.uid} (reader uid ${readerUid}, not root); refusing to honor`
    };
  }
  return { marker, managed: true };
}
function isManagedBox(root = spellguardRootDir()) {
  return readManagedMarker(root).managed;
}

// src/lib/commit-observation-emitter.ts
import { posix } from "node:path";

// src/lib/diff-overlap.ts
function linesAddedByEdit(edit) {
  const before = /* @__PURE__ */ new Set();
  for (const line of edit.contentBefore.split("\n")) {
    if (line.length > 0) before.add(line);
  }
  const added = [];
  for (const line of edit.contentAfter.split("\n")) {
    if (line.length === 0) continue;
    if (!before.has(line)) added.push(line);
  }
  return added;
}
function computeAttribution(input) {
  const perFile = {};
  let totalAttributed = 0;
  let totalLines = 0;
  for (const [path, diff] of Object.entries(input.commitDiffByFile)) {
    const edits = input.agentEditsByFile[path] ?? [];
    const editAddedArrays = edits.map((e) => ({ added: linesAddedByEdit(e), timestamp: e.timestamp })).sort((a, b) => a.timestamp < b.timestamp ? 1 : -1);
    const changed = diff.addedLines.filter((l) => l.length > 0);
    const total = changed.length;
    const remaining = /* @__PURE__ */ new Map();
    for (const e of editAddedArrays) {
      for (const line of e.added) {
        remaining.set(line, (remaining.get(line) ?? 0) + 1);
      }
    }
    let attributed = 0;
    for (const line of changed) {
      const count = remaining.get(line) ?? 0;
      if (count > 0) {
        attributed++;
        remaining.set(line, count - 1);
      }
    }
    perFile[path] = {
      totalLines: total,
      attributedLines: attributed,
      percentage: total === 0 ? 0 : attributed / total
    };
    totalAttributed += attributed;
    totalLines += total;
  }
  return {
    overallPercentage: totalLines === 0 ? 0 : totalAttributed / totalLines,
    agentAttributedLines: totalAttributed,
    totalChangedLines: totalLines,
    perFile
  };
}

// src/lib/git-remote-canonicalizer.ts
var GITHUB_HOST_ALIASES = /* @__PURE__ */ new Set(["github.com", "ssh.github.com"]);
function canonicalizeGitRemote(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const sshShortMatch = trimmed.match(
    /^git@([\w.-]+):([^/]+)\/(.+?)(?:\.git)?$/
  );
  if (sshShortMatch) {
    const host2 = sshShortMatch[1].toLowerCase();
    if (!GITHUB_HOST_ALIASES.has(host2)) return null;
    return {
      host: "github.com",
      owner: sshShortMatch[2].toLowerCase(),
      repo: sshShortMatch[3].toLowerCase(),
      isSsh: true
    };
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!GITHUB_HOST_ALIASES.has(host)) return null;
  const isSsh = url.protocol === "ssh:";
  if (!isSsh && url.protocol !== "https:" && url.protocol !== "http:")
    return null;
  const segments = url.pathname.replace(/^\/+/, "").split("/");
  if (segments.length < 2) return null;
  const [owner, repoRaw] = segments;
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/i, "");
  return {
    host: "github.com",
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase(),
    isSsh
  };
}

// src/lib/commit-observation-emitter.ts
function normalizePath(p) {
  return posix.normalize(p).replace(/^\.\//, "");
}
async function emitCommitObservation(input) {
  const canon = canonicalizeGitRemote(input.remoteUrl);
  if (!canon) return;
  const repoFullName = `${canon.owner}/${canon.repo}`;
  let rawCommitDiff;
  try {
    rawCommitDiff = await input.diffProvider(input.commitEvent.sha);
  } catch (err) {
    console.error(
      "[commit-observation-emitter] diffProvider failed:",
      { sha: input.commitEvent.sha, repo_full_name: repoFullName },
      err
    );
    return;
  }
  const commitDiffByFile = {};
  for (const [k, v] of Object.entries(rawCommitDiff)) {
    commitDiffByFile[normalizePath(k)] = v;
  }
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString();
  let edits;
  try {
    edits = await input.store.queryByDir({
      workingDir: input.workingDir,
      sinceIso
    });
  } catch (err) {
    console.error(
      "[commit-observation-emitter] store.queryByDir failed:",
      { sha: input.commitEvent.sha, repo_full_name: repoFullName },
      err
    );
    return;
  }
  const agentEditsByFile = {};
  for (const e of edits) {
    const key = normalizePath(e.filePath);
    agentEditsByFile[key] ??= [];
    agentEditsByFile[key].push({
      // Carry contentBefore through to computeAttribution so it
      // can derive "lines this edit actually added" (and not over-attribute
      // boilerplate the agent merely preserved).
      contentBefore: e.contentBefore.replace(/\r\n/g, "\n"),
      contentAfter: e.contentAfter.replace(/\r\n/g, "\n"),
      timestamp: e.timestamp
    });
  }
  const attribution = computeAttribution({
    commitDiffByFile,
    agentEditsByFile
  });
  const hasAgentAttribution = attribution.overallPercentage > 0;
  const payload = {
    kind: "commit_observation",
    commit_sha: input.commitEvent.sha,
    repo_full_name: repoFullName,
    branch: input.commitEvent.branch,
    parent_sha: input.commitEvent.parentSha,
    // `parentShas` carries every parent for merge commits, alongside
    // `parent_sha`, so the server endpoint can record all parents.
    parent_shas: input.commitEvent.parentShas,
    authored_at: input.commitEvent.authoredAt,
    // Author/committer metadata flows through the plugin path so
    // the activity feed can render meaningful "by <name>" text on commits
    // that never get audit-log expansion (e.g. SSH push from a non-Enterprise
    // org). Read from the local git via readCommitMeta in commit-watcher.
    author_name: input.commitEvent.authorName,
    author_email: input.commitEvent.authorEmail,
    committed_at: input.commitEvent.committedAt,
    committer_name: input.commitEvent.committerName,
    committer_email: input.commitEvent.committerEmail,
    message: input.commitEvent.message,
    session_id: input.sessionContext.sessionId
  };
  if (hasAgentAttribution) {
    payload.agent_id = input.sessionContext.agentId;
    payload.agent_attribution = {
      overall_percentage: attribution.overallPercentage,
      agent_attributed_lines: attribution.agentAttributedLines,
      total_changed_lines: attribution.totalChangedLines,
      // Server schema is z.array(PerFileAttributionEntry) keyed on
      // `path`. The diff-overlap algorithm returns Record<path, ...> for
      // O(1) lookup; convert here at the wire boundary.
      per_file: Object.entries(attribution.perFile).map(([path, v]) => ({
        path,
        agentLines: v.attributedLines,
        totalLines: v.totalLines,
        percentage: v.percentage
      }))
    };
  }
  const api = createManagementClient({
    baseUrl: input.apiBase,
    agentId: input.agentId,
    agentSecret: input.agentSecret,
    fetchImpl: input.fetch
  });
  try {
    const { error, response } = await api.POST("/observations/commit", {
      body: payload
    });
    if (error) {
      console.error("[commit-observation-emitter] POST failed:", {
        status: response.status,
        sha: input.commitEvent.sha,
        repo_full_name: repoFullName
      });
      return;
    }
  } catch (err) {
    console.error(
      "[commit-observation-emitter] POST failed:",
      { sha: input.commitEvent.sha, repo_full_name: repoFullName },
      err
    );
    return;
  }
}

// src/lib/config-store.ts
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync as readFileSync2,
  readdirSync,
  renameSync,
  rmSync,
  statSync as statSync2,
  symlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { homedir as homedir2, platform } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";

// src/lib/framework-slug.ts
var FRAMEWORK_SLUG = "claude-code";

// src/lib/config-store.ts
function spellguardRootDir2() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join2(xdg, "spellguard") : join2(homedir2(), ".config", "spellguard");
}
function defaultConfigDir() {
  return join2(spellguardRootDir2(), FRAMEWORK_SLUG);
}
function defaultConfigPath() {
  return join2(defaultConfigDir(), "config.json");
}
function readPrivateConfigFile(path) {
  const flags = fsConstants.O_RDONLY | (platform() === "win32" ? 0 : fsConstants.O_NOFOLLOW);
  const fd = openSync(path, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("protected config path is not a file");
    if (platform() !== "win32" && (stat.mode & 63) !== 0) {
      throw new Error("protected config file permissions are too broad");
    }
    return readFileSync2(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
function gitTokensPath(dir = defaultConfigDir()) {
  return join2(dir, "git-tokens");
}
function servedTokens(config) {
  const served = /* @__PURE__ */ new Set();
  if (config.revoked) return served;
  const entries = Object.values(config.githubCredentials ?? {});
  for (const entry of entries) {
    if (!entry.revoked && entry.scopedToken) served.add(entry.scopedToken);
  }
  if (config.scopedToken && (entries.length === 0 || served.has(config.scopedToken))) {
    served.add(config.scopedToken);
  }
  return served;
}
function keepTokens(config, keep) {
  const kept = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "scopedToken") {
      const token = value;
      if (token !== void 0 && (!token || keep.has(token))) {
        kept[key] = token;
      }
    } else if (key === "githubCredentials" && value) {
      kept[key] = Object.fromEntries(
        Object.entries(
          value
        ).map(([org, entry]) => {
          if (!entry.scopedToken || keep.has(entry.scopedToken)) {
            return [org, entry];
          }
          const { scopedToken: _dropped, ...withoutToken } = entry;
          return [org, withoutToken];
        })
      );
    } else {
      kept[key] = value;
    }
  }
  return kept;
}
function writeConfigSnapshot(path, next) {
  const bak = `${path}.bak`;
  let previous;
  try {
    previous = JSON.parse(readFileSync2(path, "utf-8"));
  } catch {
    previous = void 0;
  }
  if (previous === null || typeof previous !== "object") {
    if (next.revoked) {
      rmSync(bak, { force: true });
      return;
    }
    copyFileSync(path, bak);
  } else {
    const snapshot = keepTokens(
      previous,
      servedTokens(next)
    );
    writeFileSync(bak, JSON.stringify(snapshot, null, 2), {
      encoding: "utf-8",
      mode: 384
    });
  }
  if (platform() !== "win32") chmodSync(bak, 384);
}
function writeGitTokensFile(config, dir = defaultConfigDir()) {
  const path = gitTokensPath(dir);
  const lines = [];
  let wildcardToken;
  let usableCount = 0;
  let keyedTotal = 0;
  const keyed = config.revoked ? void 0 : config.githubCredentials;
  if (keyed && Object.keys(keyed).length > 0) {
    keyedTotal = Object.keys(keyed).length;
    for (const [org, entry] of Object.entries(keyed)) {
      if (entry.revoked) continue;
      if (!entry.scopedToken) continue;
      lines.push(`${org}	${entry.scopedToken}`);
      usableCount++;
      if (wildcardToken === void 0) wildcardToken = entry.scopedToken;
    }
  } else if (!config.revoked && config.scopedToken) {
    wildcardToken = config.scopedToken;
    usableCount = 1;
  }
  if (wildcardToken !== void 0 && usableCount === 1 && keyedTotal <= 1) {
    lines.push(`*	${wildcardToken}`);
  }
  mkdirSync(dirname2(path), { recursive: true, mode: 448 });
  const content = lines.length === 0 ? "" : `${lines.join("\n")}
`;
  const tmpPath = `${path}.tmp`;
  if (platform() !== "win32") {
    const fd = openSync(tmpPath, "w", 384);
    try {
      writeSync(fd, content, 0, "utf-8");
    } finally {
      closeSync(fd);
    }
  } else {
    writeFileSync(tmpPath, content, "utf-8");
  }
  renameSync(tmpPath, path);
  const resetMarker = join2(
    dirname2(path),
    "github-grants",
    "current",
    ".reset-tombstone"
  );
  if (!config.revoked && config.scopedToken && existsSync(resetMarker)) {
    rmSync(join2(dirname2(path), "github-grants"), {
      recursive: true,
      force: true
    });
  }
}
function healConfigMode(path, mode) {
  if (mode === 384) return "ok";
  const uid = process.getuid?.();
  let ownerUid;
  try {
    ownerUid = statSync2(path).uid;
  } catch {
    return "unhealable";
  }
  if (uid === void 0 || ownerUid !== uid) return "unhealable";
  try {
    chmodSync(path, 384);
  } catch {
    return "unhealable";
  }
  try {
    if ((statSync2(path).mode & 511) !== 384) return "unhealable";
  } catch {
    return "unhealable";
  }
  return "healed";
}
function mistypedGithubField(parsed) {
  if (parsed.scopedToken !== void 0 && typeof parsed.scopedToken !== "string")
    return "scopedToken";
  if (parsed.scopedTokenId !== void 0 && typeof parsed.scopedTokenId !== "string")
    return "scopedTokenId";
  if (parsed.expiresAt !== void 0 && typeof parsed.expiresAt !== "string")
    return "expiresAt";
  if (parsed.revokedMessage !== void 0 && typeof parsed.revokedMessage !== "string")
    return "revokedMessage";
  if (parsed.githubReissue !== void 0 && (parsed.githubReissue === null || typeof parsed.githubReissue !== "object" || parsed.githubReissue.pending !== true))
    return "githubReissue";
  return null;
}
function readConfig(path = defaultConfigPath()) {
  if (!existsSync(path)) return { config: null, reason: "missing" };
  let permissionsHealed = false;
  if (platform() !== "win32") {
    let mode;
    try {
      mode = statSync2(path).mode & 511;
    } catch {
      return { config: null, reason: "missing" };
    }
    const healed = healConfigMode(path, mode);
    if (healed === "unhealable") {
      return {
        config: null,
        reason: "wrong_permissions",
        foundMode: mode.toString(8).padStart(4, "0")
      };
    }
    permissionsHealed = healed === "healed";
  }
  let raw;
  try {
    raw = readFileSync2(path, "utf-8");
  } catch {
    return { config: null, reason: "missing" };
  }
  if (raw.trim() === "") {
    return { config: null, reason: "missing" };
  }
  try {
    const parsed = JSON.parse(raw);
    for (const field of [
      "agentSecret",
      "agentId",
      "spellguardBaseUrl"
    ]) {
      if (typeof parsed[field] !== "string") {
        return { config: null, reason: "malformed", malformedField: field };
      }
    }
    const mistyped = mistypedGithubField(parsed);
    if (mistyped) {
      return { config: null, reason: "malformed", malformedField: mistyped };
    }
    if (parsed.knownCredentials !== void 0) {
      if (!Array.isArray(parsed.knownCredentials) || !parsed.knownCredentials.every(
        (k) => k != null && typeof k.provider === "string" && typeof k.scoped_token_id === "string"
      )) {
        return {
          config: null,
          reason: "malformed",
          malformedField: "knownCredentials"
        };
      }
    }
    if (parsed.githubCredentials !== void 0) {
      const map = parsed.githubCredentials;
      if (map == null || typeof map !== "object" || Array.isArray(map) || !Object.values(map).every(
        (e) => e != null && typeof e === "object" && typeof e.scopedTokenId === "string" && typeof e.expiresAt === "string" && (e.scopedToken === void 0 || typeof e.scopedToken === "string")
      )) {
        return { config: null, reason: "malformed" };
      }
    }
    return permissionsHealed ? { config: parsed, permissionsHealed: true } : { config: parsed };
  } catch {
    return { config: null, reason: "malformed", malformedField: "json" };
  }
}
function writeConfig(config, path = defaultConfigPath(), testHooks = {}) {
  mkdirSync(dirname2(path), { recursive: true, mode: 448 });
  const persisted = keepTokens(config, servedTokens(config));
  const content = JSON.stringify(persisted, null, 2);
  if (existsSync(path)) {
    try {
      writeConfigSnapshot(path, persisted);
    } catch {
    }
  }
  const tmpPath = `${path}.tmp`;
  if (platform() !== "win32") {
    const fd = openSync(tmpPath, "w", 384);
    try {
      writeSync(fd, content, 0, "utf-8");
    } finally {
      closeSync(fd);
    }
  } else {
    writeFileSync(tmpPath, content, "utf-8");
  }
  writeGitTokensFile(persisted, dirname2(path));
  testHooks.beforeConfigCommit?.();
  renameSync(tmpPath, path);
}
function markConfigRevoked(path = defaultConfigPath(), testHooks = {}) {
  const result = readConfig(path);
  if (result.config) {
    invalidateActiveGithubGrantGeneration(
      dirname2(path),
      testHooks,
      result.config.agentId
    );
    testHooks.afterV5Invalidation?.();
    writeConfig({ ...result.config, revoked: true }, path);
  }
}
function markConfigSuperseded(message, path = defaultConfigPath(), testHooks = {}) {
  const result = readConfig(path);
  if (!result.config) return;
  invalidateActiveGithubGrantGeneration(
    dirname2(path),
    testHooks,
    result.config.agentId
  );
  testHooks.afterV5Invalidation?.();
  writeConfig(
    {
      agentId: result.config.agentId,
      agentSecret: result.config.agentSecret,
      spellguardBaseUrl: result.config.spellguardBaseUrl,
      agentName: result.config.agentName,
      revoked: true,
      revokedMessage: message
    },
    path
  );
}
function markConfigSuspended(path = defaultConfigPath(), testHooks = {}) {
  const result = readConfig(path);
  if (!result.config) return;
  const current = result.config;
  invalidateActiveGithubGrantGeneration(
    dirname2(path),
    testHooks,
    current.agentId
  );
  testHooks.afterV5Invalidation?.();
  writeConfig(
    {
      agentId: current.agentId,
      agentSecret: current.agentSecret,
      spellguardBaseUrl: current.spellguardBaseUrl,
      agentName: current.agentName,
      gitAuthorName: current.gitAuthorName,
      gitAuthorEmail: current.gitAuthorEmail,
      lastServerSeq: current.lastServerSeq,
      providerConfig: current.providerConfig,
      knownCredentials: [],
      revoked: false
    },
    path
  );
}
function syncPath(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function requireRealDirectory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`unsafe GitHub generation directory: ${path}`);
  }
}
function removeSiblingGenerations(generations, activeName) {
  requireRealDirectory(generations);
  for (const entry of readdirSync(generations, { withFileTypes: true })) {
    if (entry.name === activeName) continue;
    const candidate = join2(generations, entry.name);
    if (dirname2(candidate) !== generations) {
      throw new Error("unsafe GitHub generation cleanup target");
    }
    const stat = lstatSync(candidate);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      rmSync(candidate, { recursive: true });
    } else {
      rmSync(candidate);
    }
  }
  syncPath(generations);
}
function invalidateActiveGithubGrantGeneration(configDir, testHooks = {}, configuredAgentId) {
  const root = join2(configDir, "github-grants");
  const generations = join2(root, "generations");
  const deliveryId = randomUUID();
  const generationName = `0-${deliveryId}`;
  const generation = join2(generations, generationName);
  mkdirSync(root, { recursive: true, mode: 448 });
  requireRealDirectory(root);
  if (!existsSync(generations)) mkdirSync(generations, { mode: 448 });
  requireRealDirectory(generations);
  mkdirSync(generation, { mode: 448 });
  mkdirSync(join2(generation, "tokens"), { mode: 448 });
  let agentId = configuredAgentId;
  if (!agentId) {
    try {
      const active = JSON.parse(
        readPrivateConfigFile(join2(root, "current", "state.json"))
      );
      if (typeof active.agentId === "string") agentId = active.agentId;
      else if (typeof active.grants?.[0]?.agent_id === "string")
        agentId = active.grants[0].agent_id;
    } catch {
    }
  }
  writeFileSync(
    join2(generation, "state.json"),
    JSON.stringify({
      protocolVersion: 5,
      ...agentId ? { agentId } : {},
      deliveryId,
      grantSetRevision: "0",
      grants: []
    }),
    { mode: 384 }
  );
  writeFileSync(join2(generation, "manifest.tsv"), "\n", { mode: 384 });
  writeFileSync(join2(generation, ".reset-tombstone"), "", { mode: 384 });
  syncPath(join2(generation, "state.json"));
  syncPath(join2(generation, "manifest.tsv"));
  syncPath(join2(generation, ".reset-tombstone"));
  syncPath(join2(generation, "tokens"));
  syncPath(generation);
  syncPath(generations);
  testHooks.beforeV5Activation?.();
  const pendingCurrent = join2(root, `.current.${randomUUID()}.tmp`);
  symlinkSync(join2("generations", generationName), pendingCurrent);
  renameSync(pendingCurrent, join2(root, "current"));
  syncPath(root);
  testHooks.afterV5Activation?.();
  testHooks.beforeV5Cleanup?.();
  removeSiblingGenerations(generations, generationName);
}

// src/lib/credential-handlers.ts
import { rmSync as rmSync3 } from "node:fs";
import { join as join5 } from "node:path";

// src/lib/env-file-writer.ts
import {
  appendFileSync,
  chmodSync as chmodSync2,
  copyFileSync as copyFileSync2,
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname3, join as join3, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/git-insteadof-rules.ts
var SSH_TO_HTTPS_INSTEADOF = [
  { key: "url.https://github.com/.insteadOf", value: "git@github.com:" },
  { key: "url.https://github.com/.insteadOf", value: "ssh://git@github.com/" }
];
function repoIdentityInsteadOf(repo) {
  const base = `https://github.com/${repo.owner}/${repo.repo}`;
  return [
    { key: `url.${base}.insteadOf`, value: base },
    { key: `url.${base}.pushInsteadOf`, value: base }
  ];
}
function sshRewriteEntries(repo) {
  const entries = [...SSH_TO_HTTPS_INSTEADOF];
  if (repo) entries.push(...repoIdentityInsteadOf(repo));
  return entries;
}
function isSshRewriteEnabled(env = process.env) {
  const raw = env.SPELLGUARD_SSH_REWRITE;
  if (raw === void 0 || raw.trim() === "") return true;
  return !/^(0|off|false|no)$/i.test(raw.trim());
}

// src/lib/env-file-writer.ts
var HERE = dirname3(fileURLToPath(import.meta.url));
function bundledHelperPath() {
  return resolve(HERE, "..", "..", "bin", "spellguard-git-helper");
}
function ensureStableHelper(configDir) {
  const bundled = bundledHelperPath();
  try {
    const dest = join3(configDir, "bin", "spellguard-git-helper");
    mkdirSync2(dirname3(dest), { recursive: true });
    copyFileSync2(bundled, dest);
    chmodSync2(dest, 493);
    return dest;
  } catch {
    return bundled;
  }
}
function bashQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function writeGitConfigEnv(spec) {
  if (!spec.envFilePath) return;
  const helper = spec.helperPath ?? bundledHelperPath();
  const hasAuthor = typeof spec.gitAuthorName === "string" && spec.gitAuthorName.length > 0 && typeof spec.gitAuthorEmail === "string" && spec.gitAuthorEmail.length > 0;
  const sshRewrite = spec.sshRewrite ?? isSshRewriteEnabled();
  const lines = [
    "export GIT_CONFIG_KEY_0=credential.helper",
    "export GIT_CONFIG_VALUE_0=''",
    // disables any inherited generic helper
    "export GIT_CONFIG_KEY_1=credential.helper",
    `export GIT_CONFIG_VALUE_1=${bashQuote(helper)}`,
    "export GIT_CONFIG_KEY_2=credential.https://github.com.helper",
    "export GIT_CONFIG_VALUE_2=''",
    // disables gh / other URL-specific helpers
    "export GIT_CONFIG_KEY_3=credential.https://github.com.helper",
    `export GIT_CONFIG_VALUE_3=${bashQuote(helper)}`,
    "export GIT_CONFIG_KEY_4=credential.https://gist.github.com.helper",
    "export GIT_CONFIG_VALUE_4=''",
    "export GIT_CONFIG_KEY_5=credential.https://gist.github.com.helper",
    `export GIT_CONFIG_VALUE_5=${bashQuote(helper)}`,
    "export GIT_CONFIG_KEY_6=credential.https://github.com.useHttpPath",
    "export GIT_CONFIG_VALUE_6=true"
  ];
  let idx = 7;
  if (sshRewrite) {
    for (const rule of sshRewriteEntries(spec.sshRewriteRepo)) {
      lines.push(
        `export GIT_CONFIG_KEY_${idx}=${rule.key}`,
        `export GIT_CONFIG_VALUE_${idx}=${bashQuote(rule.value)}`
      );
      idx++;
    }
  }
  if (hasAuthor) {
    lines.push(
      `export GIT_CONFIG_KEY_${idx}=user.name`,
      `export GIT_CONFIG_VALUE_${idx}=${bashQuote(spec.gitAuthorName)}`
    );
    idx++;
    lines.push(
      `export GIT_CONFIG_KEY_${idx}=user.email`,
      `export GIT_CONFIG_VALUE_${idx}=${bashQuote(spec.gitAuthorEmail)}`
    );
    idx++;
  }
  lines.unshift(`export GIT_CONFIG_COUNT=${idx}`);
  if (spec.ghConfigDir) {
    lines.push(`export GH_CONFIG_DIR=${bashQuote(spec.ghConfigDir)}`);
  }
  if (existsSync2(spec.envFilePath)) {
    appendFileSync(spec.envFilePath, `
${lines.join("\n")}
`, "utf-8");
  } else {
    writeFileSync2(spec.envFilePath, `${lines.join("\n")}
`, "utf-8");
  }
}
function clearGitConfigEnv(envFilePath) {
  if (!envFilePath) return;
  writeFileSync2(envFilePath, "export GIT_CONFIG_COUNT=0\n", "utf-8");
}

// src/lib/gh-config-dir.ts
import {
  existsSync as existsSync3,
  mkdirSync as mkdirSync3,
  renameSync as renameSync2,
  rmSync as rmSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import { join as join4 } from "node:path";
function ghConfigDirPath(configDir, agentId) {
  return join4(configDir, "gh", agentId);
}
function writeGhSessionConfig(args) {
  const host = args.host ?? "github.com";
  mkdirSync3(args.dir, { recursive: true, mode: 448 });
  const configYml = join4(args.dir, "config.yml");
  if (!existsSync3(configYml)) {
    writeFileSync3(configYml, 'version: "1"\n', { mode: 384 });
  }
  const hosts = `${host}:
    oauth_token: ${args.token}
    git_protocol: https
`;
  const hostsTmp = join4(args.dir, "hosts.yml.tmp");
  writeFileSync3(hostsTmp, hosts, { mode: 384 });
  renameSync2(hostsTmp, join4(args.dir, "hosts.yml"));
}
function clearGhSessionConfig(dir) {
  try {
    rmSync2(join4(dir, "hosts.yml"), { force: true });
  } catch {
  }
}

// src/lib/render-message.ts
var __renderedForTest = [];
function formatRenderLine(input) {
  const prefix = input.level === "error" ? "[spellguard error]" : input.level === "warn" ? "[spellguard warn]" : "[spellguard]";
  return input.detail ? `${prefix} ${input.message} \u2014 ${input.detail}` : `${prefix} ${input.message}`;
}
function renderMessage(input) {
  __renderedForTest.push(input);
  process.stderr.write(`${formatRenderLine(input)}
`);
}

// src/lib/credential-handlers.ts
function githubEntryKey(orgLogin) {
  return (orgLogin ?? "__default").toLowerCase();
}
var RECOVERABLE_GITHUB_REVOKE_REASONS = /* @__PURE__ */ new Set(["github_side_revoked", "installation_revoked", "refresh_token_expired"]);
function githubReissueAfterFinalRevoke(frame) {
  return frame.provider === "github" && RECOVERABLE_GITHUB_REVOKE_REASONS.has(frame.reason) ? { pending: true } : void 0;
}
function finalGithubRevocationMessage(frame) {
  return githubReissueAfterFinalRevoke(frame) ? "Spellguard: GitHub credential revoked; git operations are blocked while Spellguard waits for a replacement credential." : "Spellguard: GitHub credential revoked; git operations are blocked. This terminal revocation will not request a replacement automatically.";
}
function dropStaleDefaultKey(creds, installedRealKey, supersededId) {
  const def = creds.__default;
  const shouldDrop = Boolean(def) && installedRealKey && (supersededId === void 0 || supersededId === def?.scopedTokenId);
  if (!shouldDrop) return creds;
  return Object.fromEntries(
    Object.entries(creds).filter(([key]) => key !== "__default")
  );
}
function removeLegacyGhTokenFile(deps) {
  if (!deps.configDir) return;
  try {
    rmSync3(join5(deps.configDir, "gh-token"), { force: true });
  } catch {
  }
}
function reassertHelperWiring(deps, config) {
  const managed = (deps.isManagedBox ?? isManagedBox)();
  if (managed || !deps.envFilePath) return;
  writeGitConfigEnv({
    envFilePath: deps.envFilePath,
    gitAuthorName: config.gitAuthorName,
    gitAuthorEmail: config.gitAuthorEmail,
    ghConfigDir: deps.ghConfigDir,
    helperPath: deps.helperPath,
    sshRewriteRepo: deps.sshRewriteRepo
  });
}
function handleCredentialUpdate(frame, deps) {
  const ghCreds = frame.credentials.filter(
    (c) => c.provider === "github" && Boolean(c.scoped_token)
  );
  if (ghCreds.length === 0) return false;
  const cur = deps.readConfigImpl();
  if (!cur.config) return false;
  const hadKeyedMap = cur.config.githubCredentials !== void 0 && Object.keys(cur.config.githubCredentials).length > 0;
  if (!hadKeyedMap && cur.config.revoked) return false;
  const githubCredentials = {
    ...cur.config.githubCredentials ?? {}
  };
  let firstInstalled = null;
  for (const ghCred of ghCreds) {
    const key = githubEntryKey(ghCred.github_org_login);
    const incomingId = ghCred.scoped_token_id ?? ghCred.credential_id;
    const existing = githubCredentials[key];
    if (existing?.revoked && existing.scopedTokenId === incomingId) continue;
    const entry = {
      scopedToken: ghCred.scoped_token,
      scopedTokenId: ghCred.scoped_token_id ?? ghCred.credential_id,
      expiresAt: ghCred.expires_at,
      scopeSummary: ghCred.scope_summary,
      installationId: ghCred.installation_id,
      revoked: false
    };
    githubCredentials[key] = entry;
    if (firstInstalled === null) {
      firstInstalled = {
        entry,
        authorName: ghCred.provider_data.git_author_name,
        authorEmail: ghCred.provider_data.git_author_email
      };
    }
  }
  if (firstInstalled === null) return false;
  const supersededId = "superseded_scoped_token_id" in frame ? frame.superseded_scoped_token_id : void 0;
  const installedRealKey = ghCreds.some(
    (c) => githubEntryKey(c.github_org_login) !== "__default"
  );
  const finalGithubCredentials = dropStaleDefaultKey(
    githubCredentials,
    installedRealKey,
    supersededId
  );
  deps.writeConfigImpl({
    ...cur.config,
    githubCredentials: finalGithubCredentials,
    scopedToken: firstInstalled.entry.scopedToken,
    scopedTokenId: firstInstalled.entry.scopedTokenId,
    expiresAt: firstInstalled.entry.expiresAt,
    scopeSummary: firstInstalled.entry.scopeSummary,
    agentId: ghCreds[0].agent_id,
    gitAuthorName: firstInstalled.authorName,
    gitAuthorEmail: firstInstalled.authorEmail,
    revoked: false,
    githubReissue: void 0
  });
  const managed = (deps.isManagedBox ?? isManagedBox)();
  if (!managed && deps.envFilePath) {
    writeGitConfigEnv({
      envFilePath: deps.envFilePath,
      gitAuthorName: firstInstalled.authorName,
      gitAuthorEmail: firstInstalled.authorEmail,
      ghConfigDir: deps.ghConfigDir,
      helperPath: deps.helperPath,
      // Rotation must regenerate the full rule set, incl. the repo-specific
      // rules 3/4 (out-specify a force-SSH rule); else a force-SSH user reverts
      // to host-level rules after rotation. See git-insteadof-rules.ts.
      sshRewriteRepo: deps.sshRewriteRepo
    });
  }
  if (deps.ghConfigDir && firstInstalled.entry.scopedToken) {
    writeGhSessionConfig({
      dir: deps.ghConfigDir,
      token: firstInstalled.entry.scopedToken
    });
  }
  return true;
}
function handleConfigUpdate(frame, deps) {
  const cur = deps.readConfigImpl();
  if (!cur.config) return;
  const providerConfig = {
    ...cur.config.providerConfig ?? {},
    [frame.config.provider]: frame.config
  };
  deps.writeConfigImpl({ ...cur.config, providerConfig });
}
function handleCredentialRevoked(frame, deps) {
  const cur = deps.readConfigImpl();
  const keyed = cur.config?.githubCredentials;
  if (!cur.config) return false;
  if (frame.provider !== "github") return true;
  if (!keyed || Object.keys(keyed).length === 0) {
    deps.writeConfigImpl({
      ...cur.config,
      scopedToken: void 0,
      scopedTokenId: void 0,
      expiresAt: void 0,
      scopeSummary: void 0,
      revoked: false,
      githubReissue: githubReissueAfterFinalRevoke(frame)
    });
    removeLegacyGhTokenFile(deps);
    try {
      if (deps.ghConfigDir) clearGhSessionConfig(deps.ghConfigDir);
      reassertHelperWiring(deps, cur.config);
    } catch {
    }
    renderMessage({
      level: "error",
      message: finalGithubRevocationMessage(frame)
    });
    return true;
  }
  const next = {};
  let matched = false;
  for (const [org, entry] of Object.entries(keyed)) {
    if (entry.scopedTokenId === frame.scoped_token_id) {
      matched = true;
      next[org] = { ...entry, revoked: true };
    } else {
      next[org] = entry;
    }
  }
  const anyRemaining = Object.values(next).some((e) => !e.revoked);
  if (anyRemaining) {
    const survivor = Object.values(next).find((e) => !e.revoked);
    deps.writeConfigImpl({
      ...cur.config,
      githubCredentials: next,
      scopedToken: survivor?.scopedToken,
      scopedTokenId: survivor?.scopedTokenId,
      expiresAt: survivor?.expiresAt,
      scopeSummary: survivor?.scopeSummary,
      githubReissue: void 0
    });
    removeLegacyGhTokenFile(deps);
    renderMessage({
      level: "error",
      message: matched ? "Spellguard: one GitHub org credential was revoked; pushes to that org will fail. Other orgs are unaffected." : "Spellguard: a credential revocation arrived for an unknown token; no local change."
    });
    return true;
  }
  deps.writeConfigImpl({
    ...cur.config,
    githubCredentials: next,
    scopedToken: void 0,
    scopedTokenId: void 0,
    expiresAt: void 0,
    scopeSummary: void 0,
    revoked: false,
    githubReissue: githubReissueAfterFinalRevoke(frame)
  });
  removeLegacyGhTokenFile(deps);
  try {
    if (deps.ghConfigDir) clearGhSessionConfig(deps.ghConfigDir);
    reassertHelperWiring(deps, cur.config);
  } catch {
  }
  renderMessage({
    level: "error",
    message: finalGithubRevocationMessage(frame)
  });
  return true;
}
function handleAuthFailedClose(code, deps) {
  if (code !== 4401) return false;
  deps.markConfigRevokedImpl();
  removeLegacyGhTokenFile(deps);
  try {
    clearGitConfigEnv(deps.envFilePath);
  } catch {
  }
  renderMessage({
    level: "error",
    message: "Spellguard: the server no longer recognizes this agent (auth failed). Local credentials were marked revoked \u2014 run `/spellguard-setup` to reconnect."
  });
  return true;
}
function handleSuspended(deps) {
  if (!deps.markConfigSuspendedImpl) return false;
  deps.markConfigSuspendedImpl();
  removeLegacyGhTokenFile(deps);
  try {
    if (deps.ghConfigDir) clearGhSessionConfig(deps.ghConfigDir);
  } catch {
  }
  renderMessage({
    level: "error",
    message: "Spellguard: this agent is quarantined. Its credentials were removed from this machine; it reconnects by itself once an admin releases it."
  });
  return true;
}
function isHandshakeAuthRejection(err) {
  return /Unexpected server response: 40[13]\b/.test(err?.message ?? "");
}

// src/lib/daemon-spawn.ts
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync as chmodSync3,
  existsSync as existsSync4,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync3,
  realpathSync,
  renameSync as renameSync3,
  unlinkSync,
  writeFileSync as writeFileSync4
} from "node:fs";
import { platform as platform2 } from "node:os";
import { dirname as dirname4, join as join6, resolve as resolve2, sep } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function daemonScriptPath() {
  const here = dirname4(fileURLToPath2(import.meta.url));
  const devPath = join6(
    here,
    "..",
    "..",
    "bin",
    "spellguard-credential-daemon.ts"
  );
  const builtPath = join6(here, "spellguard-credential-daemon.mjs");
  const runningFromDist = here.endsWith(`${sep}dist${sep}bin`) || here.endsWith("/dist/bin");
  if (runningFromDist && existsSync4(builtPath)) return builtPath;
  if (existsSync4(devPath)) return devPath;
  return builtPath;
}
function daemonArtifactId(scriptPath = daemonScriptPath()) {
  const canonicalPath = existsSync4(scriptPath) ? realpathSync(scriptPath) : resolve2(scriptPath);
  const hash = createHash("sha256");
  hash.update(canonicalPath);
  hash.update("\0");
  hash.update(readFileSync3(canonicalPath));
  return hash.digest("hex");
}
function startDaemonHealthReporter(args) {
  const path = join6(args.configDir, "agents", `${args.agentId}.health.json`);
  const processStartToken = readSelfStartToken();
  if (!processStartToken)
    throw new Error("could not read daemon process identity");
  let record = {
    schemaVersion: 1,
    pid: process.pid,
    processStartToken,
    agentId: args.agentId,
    configDir: resolve2(args.configDir),
    scriptPath: resolve2(args.scriptPath),
    artifactId: args.artifactId,
    instanceId: args.instanceId,
    heartbeatAt: (/* @__PURE__ */ new Date()).toISOString(),
    processState: "starting",
    transportState: "connecting",
    transportError: void 0,
    credentialState: args.credentialState
  };
  const flush = () => {
    record = { ...record, heartbeatAt: (/* @__PURE__ */ new Date()).toISOString() };
    mkdirSync4(dirname4(path), { recursive: true, mode: 448 });
    const tempPath = `${path}.${args.instanceId}.tmp`;
    writeFileSync4(tempPath, `${JSON.stringify(record)}
`, { mode: 384 });
    chmodSync3(tempPath, 384);
    renameSync3(tempPath, path);
  };
  flush();
  const interval = setInterval(flush, args.heartbeatIntervalMs ?? 1e3);
  interval.unref();
  return {
    markReady: () => {
      record = { ...record, processState: "ready" };
      flush();
    },
    setTransport: (state, error) => {
      record = { ...record, transportState: state, transportError: error };
      flush();
    },
    setCredentialState: (state) => {
      record = { ...record, credentialState: state };
      flush();
    },
    close: () => {
      clearInterval(interval);
      try {
        const current = JSON.parse(readFileSync3(path, "utf8"));
        if (current.instanceId === args.instanceId) unlinkSync(path);
      } catch {
      }
    }
  };
}
function readSelfStartToken() {
  try {
    if (platform2() === "linux") {
      const stat = readFileSync3(`/proc/${process.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] ?? null;
    }
    if (platform2() === "darwin") {
      return execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], {
        encoding: "utf8"
      }).trim();
    }
  } catch {
    return null;
  }
  return null;
}

// src/lib/edit-store.ts
import { chmodSync as chmodSync4, existsSync as existsSync5, mkdirSync as mkdirSync5 } from "node:fs";
import { join as join7 } from "node:path";

// src/lib/sqlite-backend.ts
import { createRequire } from "node:module";
var localRequire = typeof __require === "function" ? __require : createRequire(import.meta.url);
function suppressSqliteExperimentalWarning() {
  const original = process.emitWarning;
  process.emitWarning = ((warning, ...rest) => {
    const optsOrType = rest[0];
    const type = typeof optsOrType === "object" && optsOrType !== null ? optsOrType.type : optsOrType;
    const name = typeof warning === "object" ? warning?.name : void 0;
    const message = typeof warning === "string" ? warning : warning?.message ?? "";
    const isSqliteExperimental = type === "ExperimentalWarning" || name === "ExperimentalWarning" || typeof message === "string" && message.includes("SQLite is an experimental");
    if (isSqliteExperimental) return;
    return original.call(process, warning, ...rest);
  });
  return () => {
    process.emitWarning = original;
  };
}
function namedParamsIn(sql) {
  const names = /* @__PURE__ */ new Set();
  const re = /[@:$]([A-Za-z_][A-Za-z0-9_]*)/g;
  let m = re.exec(sql);
  while (m !== null) {
    names.add(m[1]);
    m = re.exec(sql);
  }
  return names;
}
function pickKnownParams(params, known) {
  if (!params) return params;
  const out = {};
  for (const key of Object.keys(params)) {
    const bare = key.replace(/^[@:$]/, "");
    if (known.has(bare)) out[bare] = params[key];
  }
  return out;
}
function adaptNodeSqlite(DatabaseSync) {
  return {
    kind: "node:sqlite",
    open(dbPath) {
      const db = new DatabaseSync(dbPath);
      const wrapStatement = (sql) => {
        const stmt = db.prepare(sql);
        const known = namedParamsIn(sql);
        return {
          run(params) {
            return stmt.run(pickKnownParams(params, known) ?? {});
          },
          get(params) {
            return stmt.get(pickKnownParams(params, known) ?? {});
          },
          all(params) {
            return stmt.all(pickKnownParams(params, known) ?? {});
          }
        };
      };
      return {
        exec(sql) {
          db.exec(sql);
        },
        prepare: wrapStatement,
        pragma(directive) {
          db.exec(`PRAGMA ${directive}`);
        },
        close() {
          db.close();
        }
      };
    }
  };
}
function adaptBetterSqlite3(Database) {
  return {
    kind: "better-sqlite3",
    open(dbPath) {
      const db = new Database(dbPath);
      const wrapStatement = (sql) => {
        const stmt = db.prepare(sql);
        const known = namedParamsIn(sql);
        return {
          // better-sqlite3 ignores extra keys already, but we sanitize too so
          // both backends receive the exact same bind object.
          run(params) {
            const p = pickKnownParams(params, known);
            return p ? stmt.run(p) : stmt.run();
          },
          get(params) {
            const p = pickKnownParams(params, known);
            return p ? stmt.get(p) : stmt.get();
          },
          all(params) {
            const p = pickKnownParams(params, known);
            return p ? stmt.all(p) : stmt.all();
          }
        };
      };
      return {
        exec(sql) {
          db.exec(sql);
        },
        prepare: wrapStatement,
        pragma(directive) {
          db.pragma(directive);
        },
        close() {
          db.close();
        }
      };
    }
  };
}
function tryNodeSqlite() {
  const restore = suppressSqliteExperimentalWarning();
  try {
    const mod = localRequire("node:sqlite");
    if (!mod?.DatabaseSync) return null;
    const backend2 = adaptNodeSqlite(mod.DatabaseSync);
    const probe = backend2.open(":memory:");
    probe.exec("CREATE TABLE __probe (x); DROP TABLE __probe;");
    probe.close();
    return backend2;
  } catch {
    return null;
  } finally {
    restore();
  }
}
function tryBetterSqlite3() {
  try {
    const Database = localRequire("better-sqlite3");
    return adaptBetterSqlite3(Database);
  } catch {
    return null;
  }
}
var cachedBackend;
function loadSqliteBackend() {
  if (cachedBackend !== void 0) return cachedBackend;
  cachedBackend = tryNodeSqlite() ?? tryBetterSqlite3() ?? null;
  return cachedBackend;
}

// src/lib/edit-store.ts
var backend = loadSqliteBackend();
var warnedDegraded = false;
function noopStore() {
  if (!warnedDegraded) {
    warnedDegraded = true;
    process.stderr.write(
      "[spellguard-plugin] edit-store unavailable (no SQLite backend: node:sqlite not flag-free on this Node and better-sqlite3 not installed). Edit history will not be recorded; commit-observation correlation is degraded. Run /spellguard-setup or upgrade to Node 24+ to enable it.\n"
    );
  }
  return {
    async record(_r) {
    },
    async queryByDir(_input) {
      return [];
    },
    async pruneOlderThan(_input) {
    },
    close() {
    }
  };
}
function openEditStore(opts) {
  if (!backend) return noopStore();
  mkdirSync5(opts.rootDir, { recursive: true });
  tryChmod(opts.rootDir, 448);
  const dbPath = join7(opts.rootDir, "edits.db");
  const db = backend.open(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      working_dir TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_before TEXT NOT NULL,
      content_after TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS edits_dir_ts ON edits (working_dir, timestamp);
  `);
  const insert = db.prepare(`
    INSERT INTO edits (working_dir, file_path, content_before, content_after, session_id, agent_id, timestamp)
    VALUES (@workingDir, @filePath, @contentBefore, @contentAfter, @sessionId, @agentId, @timestamp)
  `);
  const queryStmt = db.prepare(`
    SELECT working_dir AS workingDir, file_path AS filePath,
           content_before AS contentBefore, content_after AS contentAfter,
           session_id AS sessionId, agent_id AS agentId, timestamp
    FROM edits
    WHERE working_dir = @workingDir AND (@since IS NULL OR timestamp >= @since)
    ORDER BY timestamp ASC
  `);
  const pruneStmt = db.prepare("DELETE FROM edits WHERE timestamp < @cutoff");
  pruneStmt.run({
    cutoff: new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString()
  });
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync5(path)) tryChmod(path, 384);
  }
  return {
    async record(r) {
      insert.run(r);
    },
    async queryByDir(input) {
      return queryStmt.all({
        workingDir: input.workingDir,
        since: input.sinceIso ?? null
      });
    },
    async pruneOlderThan(input) {
      pruneStmt.run({ cutoff: input.olderThanIso });
    },
    close() {
      db.close();
    }
  };
}
function tryChmod(path, mode) {
  try {
    chmodSync4(path, mode);
  } catch {
  }
}

// src/lib/git-root.ts
import { execFileSync as execFileSync2 } from "node:child_process";
function resolveGitRoot(cwd) {
  try {
    return execFileSync2("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return cwd;
  }
}

// src/lib/git-show-parser.ts
var DIFF_HEADER = /^diff --git /;
var PLUS_PLUS_PLUS = /^\+\+\+ (?:b\/(.+)|\/dev\/null\s*$)/;
var MINUS_MINUS_MINUS = /^--- (?:a\/(.+)|\/dev\/null\s*$)/;
var METADATA_PREFIXES = [
  "@@",
  "index ",
  "similarity index ",
  "rename from ",
  "rename to ",
  "new file mode ",
  "deleted file mode ",
  "old mode ",
  "new mode ",
  "Binary files ",
  "\\ No newline at end of file"
];
function isMetadataLine(line) {
  for (const prefix of METADATA_PREFIXES) {
    if (line.startsWith(prefix)) return true;
  }
  return false;
}
function parseShowDiff(output) {
  const result = {};
  let current = null;
  let aPath = null;
  let inDiffSection = false;
  for (const line of output.split("\n")) {
    if (DIFF_HEADER.test(line)) {
      current = null;
      aPath = null;
      inDiffSection = true;
      continue;
    }
    if (!inDiffSection) continue;
    const minusMatch = MINUS_MINUS_MINUS.exec(line);
    if (minusMatch) {
      aPath = minusMatch[1] ?? null;
      continue;
    }
    const plusMatch = PLUS_PLUS_PLUS.exec(line);
    if (plusMatch) {
      const path = plusMatch[1] ?? aPath;
      if (path) {
        current = result[path] ?? { addedLines: [], removedLines: [] };
        result[path] = current;
      } else {
        current = null;
      }
      continue;
    }
    if (!current || isMetadataLine(line)) continue;
    if (line.startsWith("+")) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.removedLines.push(line.slice(1));
    }
  }
  return result;
}

// src/lib/github-grant-generation.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import {
  accessSync,
  closeSync as closeSync2,
  constants as fsConstants2,
  fstatSync as fstatSync2,
  lstatSync as lstatSync2,
  openSync as openSync2,
  readSync,
  readlinkSync,
  rmSync as rmSync4,
  statSync as statSync3
} from "node:fs";
import {
  lstat,
  mkdir as mkdir2,
  open,
  readdir,
  rename,
  rm,
  symlink,
  writeFile as writeFile2
} from "node:fs/promises";
import { basename, dirname as dirname5, join as join8 } from "node:path";
function removeLegacyGhTokenFile2(configDir) {
  try {
    rmSync4(join8(configDir, "gh-token"), { force: true });
  } catch {
  }
}
function generationAgentId(state) {
  if (UUID_PATTERN.test(state.agentId)) return state.agentId;
  const legacyAgentId = state.grants[0]?.agent_id;
  return typeof legacyAgentId === "string" && UUID_PATTERN.test(legacyAgentId) ? legacyAgentId : null;
}
function bundleAgentId(configDir, frame) {
  const memberAgentId = frame.credentials[0]?.agent_id;
  const localAgentId = readConfig(join8(configDir, "config.json")).config?.agentId;
  if (memberAgentId && localAgentId && memberAgentId !== localAgentId) {
    throw new Error("GitHub grant bundle belongs to a different agent");
  }
  const agentId = memberAgentId ?? localAgentId;
  if (!agentId || !UUID_PATTERN.test(agentId)) {
    throw new Error("GitHub grant bundle has no authenticated agent identity");
  }
  if (frame.credentials.some((credential) => credential.agent_id !== agentId)) {
    throw new Error("GitHub grant bundle contains mixed agent identities");
  }
  return agentId;
}
async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function removeSupersededGenerations(root, generations, activeRevision, removeEveryInactiveGeneration = false) {
  const rootStat = await lstat(generations);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("unsafe GitHub generations directory");
  }
  const currentTarget = readlinkSync(join8(root, "current"));
  const currentMatch = CURRENT_TARGET_PATTERN.exec(currentTarget);
  if (!currentMatch || currentMatch[1] !== activeRevision) {
    throw new Error("GitHub generation changed before cleanup");
  }
  for (const entry of await readdir(generations, { withFileTypes: true })) {
    const generationMatch = CURRENT_TARGET_PATTERN.exec(
      `generations/${entry.name}`
    );
    const stagingMatch = STAGING_NAME_PATTERN.exec(entry.name);
    const revision = generationMatch?.[1] ?? stagingMatch?.[1];
    if (!revision || !removeEveryInactiveGeneration && BigInt(revision) > BigInt(activeRevision))
      continue;
    if (generationMatch && entry.name === basename(currentTarget)) continue;
    const candidate = join8(generations, entry.name);
    if (dirname5(candidate) !== generations) {
      throw new Error("unsafe GitHub generation cleanup target");
    }
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    await rm(candidate, { recursive: true });
  }
  await syncDirectory(generations);
}
async function currentState(root) {
  try {
    const raw = readPrivateConfigFile(join8(root, "current", "state.json"));
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function matchesActiveGeneration(root, current, frame) {
  const grants = frame.credentials.map(
    ({ scoped_token: _secret, ...grant }) => grant
  );
  if (JSON.stringify(current.grants) !== JSON.stringify(grants)) return false;
  for (const grant of frame.credentials) {
    const token = readPrivateConfigFile(
      join8(root, "current", "tokens", grant.grant_id)
    );
    if (token !== `${grant.scoped_token}
`) return false;
  }
  return true;
}
function grantSetGitAuthor(frame) {
  const providerData = frame.credentials[0]?.provider_data;
  if (!providerData) return null;
  const { git_author_name: name, git_author_email: email } = providerData;
  if (!name || !email) return null;
  return { name, email };
}
function establishGitAuthorIdentity(configDir, author) {
  if (!author) return;
  const configPath = join8(configDir, "config.json");
  const current = readConfig(configPath);
  if (!current.config) return;
  if (current.config.gitAuthorName === author.name && current.config.gitAuthorEmail === author.email) {
    return;
  }
  writeConfig(
    {
      ...current.config,
      gitAuthorName: author.name,
      gitAuthorEmail: author.email
    },
    configPath
  );
}
async function applyGithubGrantBundle(configDir, frame, testHooks = {}) {
  const parsed = parseServerFrame(JSON.stringify(frame));
  if (!parsed || parsed.type !== "github_grants_bundle") {
    throw new Error("invalid GitHub grant bundle");
  }
  const root = join8(configDir, "github-grants");
  const generations = join8(root, "generations");
  await mkdir2(generations, { recursive: true, mode: 448 });
  const gitAuthor = grantSetGitAuthor(frame);
  const agentId = bundleAgentId(configDir, frame);
  const current = await currentState(root);
  const incoming = BigInt(frame.grant_set_revision);
  let replacingAgent = false;
  if (current) {
    const activeAgentId = generationAgentId(current);
    if (!activeAgentId && current.grantSetRevision !== "0") {
      throw new Error("active GitHub grant generation has no agent identity");
    }
    const sameAgent = activeAgentId === agentId;
    replacingAgent = activeAgentId !== null && !sameAgent;
    const active = BigInt(current.grantSetRevision);
    if (sameAgent && incoming < active)
      throw new Error("stale GitHub grant set revision");
    if (sameAgent && incoming === active) {
      if (current.deliveryId === frame.delivery_id || await matchesActiveGeneration(root, current, frame)) {
        establishGitAuthorIdentity(configDir, gitAuthor);
        removeLegacyGhTokenFile2(configDir);
        await removeSupersededGenerations(
          root,
          generations,
          current.grantSetRevision
        );
        return;
      }
      throw new Error("conflicting GitHub grant set revision");
    }
  }
  const generationName = `${frame.grant_set_revision}-${frame.delivery_id}`;
  const staging = join8(
    generations,
    `.${generationName}.${randomUUID2()}.staging`
  );
  const destination = join8(generations, generationName);
  await rm(destination, { recursive: true, force: true });
  await mkdir2(join8(staging, "tokens"), { recursive: true, mode: 448 });
  const state = {
    protocolVersion: 5,
    agentId,
    deliveryId: frame.delivery_id,
    grantSetRevision: frame.grant_set_revision,
    grants: frame.credentials.map(
      ({ scoped_token: _secret, ...grant }) => grant
    ),
    ...gitAuthor ? { gitAuthor } : {}
  };
  await writeFile2(join8(staging, "state.json"), JSON.stringify(state, null, 2), {
    mode: 384,
    flag: "wx"
  });
  const manifest = [];
  for (const grant of frame.credentials) {
    const tokenName = grant.grant_id;
    const tokenPath = join8(staging, "tokens", tokenName);
    await writeFile2(tokenPath, `${grant.scoped_token}
`, {
      mode: 384,
      flag: "wx"
    });
    const repositories = grant.scope.mode === "selected" ? grant.scope.repository_names.join(",") : "";
    manifest.push(
      [
        grant.github_org_login.toLowerCase(),
        grant.grant_id,
        `tokens/${tokenName}`,
        grant.scope.mode,
        repositories
      ].join("	")
    );
  }
  await writeFile2(join8(staging, "manifest.tsv"), `${manifest.join("\n")}
`, {
    mode: 384,
    flag: "wx"
  });
  await syncDirectory(join8(staging, "tokens"));
  await syncDirectory(staging);
  await rename(staging, destination);
  await syncDirectory(generations);
  establishGitAuthorIdentity(configDir, gitAuthor);
  await testHooks.beforeActivate?.();
  const nextLink = join8(root, `.current.${randomUUID2()}`);
  await symlink(join8("generations", basename(destination)), nextLink);
  await rename(nextLink, join8(root, "current"));
  await syncDirectory(root);
  removeLegacyGhTokenFile2(configDir);
  await removeSupersededGenerations(
    root,
    generations,
    frame.grant_set_revision,
    replacingAgent
  );
}
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var CURRENT_TARGET_PATTERN = /^generations\/(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
var STAGING_NAME_PATTERN = /^\.(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.staging$/i;
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function protectedArtifactSize(path) {
  const flags = fsConstants2.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants2.O_NOFOLLOW);
  try {
    const fd = openSync2(path, flags);
    try {
      const stat = fstatSync2(fd);
      if (!stat.isFile()) return null;
      if (process.platform !== "win32" && (stat.mode & 63) !== 0)
        return null;
      return stat.size;
    } finally {
      closeSync2(fd);
    }
  } catch {
    return null;
  }
}
function tokenArtifactIsUsable(path) {
  const size = protectedArtifactSize(path);
  return size !== null && size > 1;
}
function freezeGeneration(root, afterReadlink) {
  const current = join8(root, "current");
  try {
    if (!lstatSync2(current).isSymbolicLink()) return { state: "unavailable" };
  } catch (error) {
    return error.code === "ENOENT" ? { state: "absent" } : { state: "unavailable" };
  }
  try {
    const target = readlinkSync(current);
    const match = CURRENT_TARGET_PATTERN.exec(target);
    if (!match) return { state: "unavailable" };
    const generations = join8(root, "generations");
    const generation = join8(root, target);
    const generationsStat = lstatSync2(generations);
    const generationStat = lstatSync2(generation);
    if (generationsStat.isSymbolicLink() || !generationsStat.isDirectory() || generationStat.isSymbolicLink() || !generationStat.isDirectory()) {
      return { state: "unavailable" };
    }
    afterReadlink?.();
    return {
      state: "selected",
      path: generation,
      revision: match[1],
      deliveryId: match[2]
    };
  } catch {
    return { state: "unavailable" };
  }
}
function selectFrozenGeneration(configDir, afterReadlink) {
  const framework = freezeGeneration(
    join8(configDir, "github-grants"),
    afterReadlink
  );
  if (framework.state !== "absent") return framework;
  return freezeGeneration(
    join8(dirname5(configDir), "github-grants"),
    afterReadlink
  );
}
function parseGenerationHeader(state, manifest, frozen) {
  if (!isRecord(state) || state.protocolVersion !== 5) return null;
  if (state.deliveryId !== frozen.deliveryId) return null;
  if (state.grantSetRevision !== frozen.revision) return null;
  if (!Array.isArray(state.grants) || !manifest.endsWith("\n")) return null;
  const body = manifest.slice(0, -1);
  const lines = body === "" ? [] : body.split("\n");
  if (lines.length !== state.grants.length) return null;
  return { grants: state.grants, lines };
}
function managedGrant(raw) {
  return {
    grantId: raw.grantId,
    agentId: raw.agentId,
    owner: raw.owner,
    mode: raw.mode,
    repositories: raw.repositoryNames,
    scopedTokenId: raw.scopedTokenId,
    expiresAt: raw.expiresAt
  };
}
function frameworkGrant(raw) {
  if (raw.provider !== "github" || raw.status !== "valid") return null;
  const scope = isRecord(raw.scope) ? raw.scope : {};
  return {
    grantId: raw.grant_id,
    agentId: raw.agent_id,
    owner: raw.github_org_login,
    mode: scope.mode,
    repositories: scope.repository_names,
    scopedTokenId: raw.scoped_token_id,
    expiresAt: raw.expires_at
  };
}
function validNormalizedGrant(grant, allowExpired = false) {
  if (!UUID_PATTERN.test(grant.grantId) || !UUID_PATTERN.test(grant.agentId)) {
    return false;
  }
  if (!grant.owner || grant.owner.trim() !== grant.owner) return false;
  if (!grant.scopedTokenId.trim() || !Number.isFinite(Date.parse(grant.expiresAt))) {
    return false;
  }
  grant.owner = grant.owner.toLowerCase();
  if (!allowExpired && Date.parse(grant.expiresAt) <= Date.now()) return false;
  if (grant.mode === "all") {
    if (grant.repositories !== void 0 && (!Array.isArray(grant.repositories) || grant.repositories.length > 0)) {
      return false;
    }
    grant.repositories = [];
    return true;
  }
  if (grant.mode !== "selected" || !Array.isArray(grant.repositories)) {
    return false;
  }
  if (grant.repositories.length === 0) return false;
  const repositories = /* @__PURE__ */ new Set();
  for (const repo of grant.repositories) {
    if (typeof repo !== "string" || repo !== repo.toLowerCase()) return false;
    const [owner, name, ...extra] = repo.split("/");
    if (owner !== grant.owner || !name || extra.length > 0) return false;
    if (repositories.has(repo)) return false;
    repositories.add(repo);
  }
  if (repositories.size !== grant.repositories.length) {
    return false;
  }
  return true;
}
function normalizeGrant(raw, revision, allowExpired = false) {
  if (!isRecord(raw)) return null;
  const managed = typeof raw.grantId === "string";
  if (!managed && raw.grant_set_revision !== revision) return null;
  const grant = managed ? managedGrant(raw) : frameworkGrant(raw);
  if (!grant || !validNormalizedGrant(grant, allowExpired)) return null;
  return grant;
}
function expiryEntriesFromGeneration(frozen, state, manifest, agentId) {
  const header = parseGenerationHeader(state, manifest, frozen);
  if (!header) return { state: "unavailable" };
  const seenGrants = /* @__PURE__ */ new Set();
  const seenOwners = /* @__PURE__ */ new Set();
  const seenTokens = /* @__PURE__ */ new Set();
  const entries = [];
  for (let index = 0; index < header.lines.length; index++) {
    const fields = header.lines[index].split("	");
    const grant = normalizeGrant(header.grants[index], frozen.revision, true);
    if (!grant || grant.agentId !== agentId || seenOwners.has(grant.owner) || seenTokens.has(grant.scopedTokenId)) {
      return { state: "unavailable" };
    }
    if (!matchManifestGrant(frozen.path, fields, grant, seenGrants)) {
      return { state: "unavailable" };
    }
    seenOwners.add(grant.owner);
    seenTokens.add(grant.scopedTokenId);
    entries.push({
      scopedTokenId: grant.scopedTokenId,
      expiresAt: grant.expiresAt
    });
  }
  return { state: "available", entries };
}
function primaryTokenFromGeneration(frozen, state, manifest, agentId) {
  const header = parseGenerationHeader(state, manifest, frozen);
  if (!header || !isRecord(state)) return { state: "unavailable" };
  const persistedAgentId = state.agentId;
  if (persistedAgentId !== void 0 && (typeof persistedAgentId !== "string" || persistedAgentId !== agentId)) {
    return { state: "unavailable" };
  }
  if (header.lines.length === 0) {
    return persistedAgentId === agentId ? { state: "available", token: null } : { state: "unavailable" };
  }
  const seenGrants = /* @__PURE__ */ new Set();
  const seenOwners = /* @__PURE__ */ new Set();
  const seenTokens = /* @__PURE__ */ new Set();
  let primaryGrantId;
  for (let index = 0; index < header.lines.length; index++) {
    const fields = header.lines[index].split("	");
    const grant = normalizeGrant(header.grants[index], frozen.revision);
    if (!grant || grant.agentId !== agentId || seenOwners.has(grant.owner) || seenTokens.has(grant.scopedTokenId) || !matchManifestGrant(frozen.path, fields, grant, seenGrants)) {
      return { state: "unavailable" };
    }
    seenOwners.add(grant.owner);
    seenTokens.add(grant.scopedTokenId);
    primaryGrantId ??= grant.grantId;
  }
  if (!primaryGrantId) return { state: "unavailable" };
  try {
    const raw = readPrivateConfigFile(
      join8(frozen.path, "tokens", primaryGrantId)
    );
    if (!raw.endsWith("\n")) return { state: "unavailable" };
    const token = raw.slice(0, -1);
    if (!token || /[\r\n]/.test(token)) return { state: "unavailable" };
    return { state: "available", token };
  } catch {
    return { state: "unavailable" };
  }
}
function matchManifestGrant(generationPath, fields, grant, seen) {
  if (fields.length !== 5) return null;
  const [owner, grantId, tokenRelative, mode, repositories] = fields;
  if (seen.has(grantId) || grantId !== grant.grantId) return null;
  if (owner !== grant.owner || mode !== grant.mode) return null;
  if (repositories !== grant.repositories.join(",")) return null;
  if (tokenRelative !== `tokens/${grantId}`) return null;
  if (!tokenArtifactIsUsable(join8(generationPath, tokenRelative))) return null;
  seen.add(grantId);
  return grant;
}
function readActiveGithubGrantExpiryEntries(configDir, agentId, options = {}) {
  const selected = selectFrozenGeneration(
    configDir,
    options.afterCurrentReadlink
  );
  if (selected.state !== "selected") return selected;
  try {
    const state = JSON.parse(
      readPrivateConfigFile(join8(selected.path, "state.json"))
    );
    const manifest = readPrivateConfigFile(join8(selected.path, "manifest.tsv"));
    return expiryEntriesFromGeneration(selected, state, manifest, agentId);
  } catch {
    return { state: "unavailable" };
  }
}
function readActiveGithubGrantPrimaryToken(configDir, agentId, options = {}) {
  const selected = selectFrozenGeneration(
    configDir,
    options.afterCurrentReadlink
  );
  if (selected.state !== "selected") return selected;
  try {
    const state = JSON.parse(
      readPrivateConfigFile(join8(selected.path, "state.json"))
    );
    const manifest = readPrivateConfigFile(join8(selected.path, "manifest.tsv"));
    return primaryTokenFromGeneration(selected, state, manifest, agentId);
  } catch {
    return { state: "unavailable" };
  }
}

// src/lib/log-all-ref-updates-probe.ts
import { execFileSync as execFileSync3 } from "node:child_process";
function checkLogAllRefUpdates(cwd) {
  try {
    const out = execFileSync3(
      "git",
      ["config", "--get", "core.logAllRefUpdates"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    ).toString().trim().toLowerCase();
    if (out === "false" || out === "0") {
      return { shouldWarn: true, reason: "disabled" };
    }
    return { shouldWarn: false, reason: "enabled" };
  } catch {
    return { shouldWarn: false, reason: "unset" };
  }
}

// src/lib/login-relay-handler.ts
import { execFile } from "node:child_process";
import {
  appendFileSync as appendFileSync2,
  chmodSync as chmodSync5,
  existsSync as existsSync6,
  mkdirSync as mkdirSync6,
  readFileSync as readFileSync4,
  writeFileSync as writeFileSync5
} from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join9 } from "node:path";
var URL_PATTERN = /https:\/\/[^\s'"]+(?:oauth|authorize|login)[^\s'"]*/i;
var ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s) {
  return s.replace(ANSI_PATTERN, "");
}
async function makeNodePtySpawner() {
  const ptyModuleName = "node-pty";
  const nodePty = await import(
    /* @vite-ignore */
    ptyModuleName
  ).catch(
    () => {
      throw new Error(
        "node-pty could not be loaded. It ships with @spellguard/claude-code-plugin (dependencies + vendored node_modules); a load failure usually means the native addon failed to build for this Node/arch. Reinstall the plugin or rebuild node-pty for this platform."
      );
    }
  );
  return (cmd, args) => {
    const pty = nodePty.spawn(cmd, args, {
      name: "xterm-color",
      // Wide terminal so claude's long OAuth URL is printed on ONE line and is
      // NEVER wrapped across rows (an 80-col wrap inserts a newline mid-URL,
      // which the URL regex treats as the end of the URL → truncation).
      cols: 1e3,
      rows: 50
    });
    return {
      onData(cb) {
        pty.onData(cb);
      },
      write(data) {
        pty.write(data);
      },
      onExit(cb) {
        pty.onExit(({ exitCode }) => cb(exitCode));
      },
      kill() {
        pty.kill();
      }
    };
  };
}
var LOGIN_MARKER_PATH = join9(homedir3(), ".claude-oauth-token");
var LOGIN_MARKER_SENTINEL = "spellguard:authenticated-via-claude-auth-login\n";
function defaultMarkAuthenticated(markerPath = LOGIN_MARKER_PATH, configPath = CLAUDE_CONFIG_PATH) {
  const dir = homedir3();
  if (!existsSync6(dir)) mkdirSync6(dir, { recursive: true });
  writeFileSync5(markerPath, LOGIN_MARKER_SENTINEL, {
    encoding: "utf-8",
    mode: 384
  });
  chmodSync5(markerPath, 384);
  seedClaudeOnboarding(configPath);
}
var CLAUDE_CONFIG_PATH = join9(homedir3(), ".claude.json");
function seedClaudeOnboarding(configPath = CLAUDE_CONFIG_PATH, projectDir = homedir3()) {
  let cfg = {};
  if (existsSync6(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync4(configPath, "utf-8"));
      if (parsed && typeof parsed === "object") {
        cfg = parsed;
      }
    } catch {
      cfg = {};
    }
  }
  cfg.hasCompletedOnboarding = true;
  if (!cfg.theme) cfg.theme = "dark";
  const projects = cfg.projects && typeof cfg.projects === "object" ? cfg.projects : {};
  projects[projectDir] = {
    ...projects[projectDir] ?? {},
    hasTrustDialogAccepted: true
  };
  cfg.projects = projects;
  writeFileSync5(configPath, JSON.stringify(cfg), {
    encoding: "utf-8",
    mode: 384
  });
  chmodSync5(configPath, 384);
}
function defaultIsLoggedIn() {
  return new Promise((resolve4) => {
    execFile(
      "claude",
      ["auth", "status", "--json"],
      { timeout: 15e3, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve4(false);
          return;
        }
        try {
          const parsed = JSON.parse(stripAnsi(String(stdout)));
          resolve4(parsed?.loggedIn === true);
        } catch {
          resolve4(false);
        }
      }
    );
  });
}
var PTY_BUFFER_MAX = 64 * 1024;
var TOKEN_EXCHANGE_TIMEOUT_MS = 3 * 60 * 1e3;
var SUBMIT_ENTER_DELAY_MS = 300;
var AUTH_POLL_INTERVAL_MS = 1500;
function handlePhase1(buffer, state, pty, deps, timeoutMs, finish, onCodeSubmitted) {
  if (state.urlTransitionFired) return;
  const urlMatch = URL_PATTERN.exec(stripAnsi(buffer));
  if (!urlMatch) return;
  state.urlTransitionFired = true;
  state.urlFound = true;
  const loginUrl = urlMatch[0];
  deps.sendUpdate({ state: "url_ready", login_url: loginUrl });
  deps.sendUpdate({ state: "awaiting_code", login_url: loginUrl });
  state.codeWaitTimeout = setTimeout(() => {
    finish(false, "timed out waiting for login code from dashboard");
  }, timeoutMs);
  deps.waitForCode().then((code) => {
    if (state.done) return;
    if (state.codeWaitTimeout) {
      clearTimeout(state.codeWaitTimeout);
      state.codeWaitTimeout = null;
    }
    state.codeSubmitted = true;
    pty.write(code);
    const enterDelayMs = deps.submitEnterDelayMs ?? SUBMIT_ENTER_DELAY_MS;
    setTimeout(() => {
      if (state.done) return;
      pty.write("\r");
    }, enterDelayMs);
    onCodeSubmitted();
  }).catch((err) => {
    finish(
      false,
      `error waiting for code: ${err instanceof Error ? err.message : String(err)}`
    );
  });
}
function debugCaptureRelayOutput(data) {
  try {
    const redacted = data.replace(
      /sk-ant-[A-Za-z0-9_-]{8,}/g,
      (m) => `${m.slice(0, 14)}<redacted:${m.length}>`
    );
    appendFileSync2(
      join9(homedir3(), ".spellguard-relay-debug.log"),
      redacted,
      "utf-8"
    );
  } catch {
  }
}
async function runLoginRelay(deps) {
  const envTimeout = Number(process.env.SPELLGUARD_LOGIN_RELAY_TIMEOUT_MS);
  const timeoutMs = deps.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 15 * 60 * 1e3);
  const pollIntervalMs = deps.pollIntervalMs ?? AUTH_POLL_INTERVAL_MS;
  if (deps.signal?.aborted) return { ok: false };
  return new Promise((resolve4) => {
    const pty = deps.spawnPty("claude", ["auth", "login", "--claudeai"]);
    const st = {
      urlFound: false,
      codeSubmitted: false,
      done: false,
      codeWaitTimeout: null,
      authPollTimer: null,
      authResolved: false,
      ptyBuffer: "",
      urlTransitionFired: false
    };
    let masterTimeout = null;
    function finish(ok, message) {
      if (st.done) return;
      st.done = true;
      if (masterTimeout) clearTimeout(masterTimeout);
      if (st.codeWaitTimeout) clearTimeout(st.codeWaitTimeout);
      if (st.authPollTimer) clearTimeout(st.authPollTimer);
      if (!ok) {
        deps.sendUpdate({ state: "failed", message });
        pty.kill();
        resolve4({ ok: false });
      } else {
        pty.kill();
        resolve4({ ok: true });
      }
    }
    if (deps.signal) {
      if (deps.signal.aborted) {
        pty.kill();
        resolve4({ ok: false });
        return;
      }
      deps.signal.addEventListener("abort", () => {
        if (!st.done) {
          st.done = true;
          if (masterTimeout) clearTimeout(masterTimeout);
          if (st.codeWaitTimeout) clearTimeout(st.codeWaitTimeout);
          if (st.authPollTimer) clearTimeout(st.authPollTimer);
          pty.kill();
          resolve4({ ok: false });
        }
      });
    }
    masterTimeout = setTimeout(() => {
      finish(false, "login relay timed out");
    }, timeoutMs);
    const pollAuthStatus = () => {
      if (st.done || st.authResolved) return;
      deps.isLoggedIn().then((loggedIn) => {
        if (st.done || st.authResolved) return;
        if (loggedIn) {
          st.authResolved = true;
          deps.markAuthenticated();
          deps.sendUpdate({ state: "authorized" });
          finish(true);
          return;
        }
        st.authPollTimer = setTimeout(pollAuthStatus, pollIntervalMs);
      }).catch(() => {
        if (st.done || st.authResolved) return;
        st.authPollTimer = setTimeout(pollAuthStatus, pollIntervalMs);
      });
    };
    const armCompletionWindow = () => {
      if (st.done) return;
      if (masterTimeout) clearTimeout(masterTimeout);
      const completionWindow = Math.min(TOKEN_EXCHANGE_TIMEOUT_MS, timeoutMs);
      masterTimeout = setTimeout(() => {
        finish(
          false,
          `timed out waiting for claude auth login to complete (bufferLen=${st.ptyBuffer.length})`
        );
      }, completionWindow);
      st.authPollTimer = setTimeout(pollAuthStatus, pollIntervalMs);
    };
    pty.onData((data) => {
      if (st.done) return;
      if (process.env.SPELLGUARD_LOGIN_RELAY_DEBUG === "1") {
        debugCaptureRelayOutput(data);
      }
      st.ptyBuffer = (st.ptyBuffer + data).slice(-PTY_BUFFER_MAX);
      if (!st.urlFound) {
        handlePhase1(
          st.ptyBuffer,
          st,
          pty,
          deps,
          timeoutMs,
          finish,
          armCompletionWindow
        );
      }
    });
    pty.onExit((exitCode) => {
      if (st.done || st.authResolved) return;
      if (exitCode !== 0) {
        finish(false, `claude auth login exited with code ${exitCode}`);
        return;
      }
      if (!st.codeSubmitted) {
        finish(
          false,
          "claude auth login exited before a login code was submitted"
        );
        return;
      }
      pollAuthStatus();
    });
  });
}

// src/lib/plugin-sync.ts
var FRAMEWORK = "claude_code";

// src/lib/ssh-remote-detect.ts
import { execFileSync as execFileSync4 } from "node:child_process";

// src/lib/ssh-remote-parse.ts
var SCP_RE = /^[\w.-]+@([\w.-]+):([^/]+)\/([^/]+?)(?:\.git)?$/;
var SSH_URL_RE = /^ssh:\/\/[\w.-]+@([\w.-]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/;
function parseSshRemote(remote) {
  if (typeof remote !== "string" || remote.length === 0) return null;
  const trimmed = remote.trim();
  let m = SCP_RE.exec(trimmed);
  if (m) {
    const [, , owner, repo] = m;
    if (owner && repo) return { owner, repo };
  }
  m = SSH_URL_RE.exec(trimmed);
  if (m) {
    const [, , owner, repo] = m;
    if (owner && repo) return { owner, repo };
  }
  return null;
}

// src/lib/ssh-remote-detect.ts
function detectSshRemoteFromOutput(output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^\S+\s+(\S+)\s+\(/);
    if (!match) continue;
    const url = match[1];
    const canon = canonicalizeGitRemote(url);
    if (canon?.isSsh) {
      return { hasSsh: true, sshRemoteUrl: url };
    }
    if (/^git@[\w.-]+:/.test(url) || url.startsWith("ssh://")) {
      return { hasSsh: true, sshRemoteUrl: url };
    }
  }
  return { hasSsh: false };
}
function detectSshRemote(cwd) {
  try {
    const out = execFileSync4("git", ["remote", "-v"], {
      encoding: "utf-8",
      cwd
    });
    return detectSshRemoteFromOutput(out);
  } catch {
    return { hasSsh: false };
  }
}
function repoIdentityFromSshDetection(result) {
  if (!result.hasSsh || !result.sshRemoteUrl) return void 0;
  const parsed = parseSshRemote(result.sshRemoteUrl);
  return parsed ? { owner: parsed.owner, repo: parsed.repo } : void 0;
}
function resolveSshRewriteRepo(cwd) {
  return repoIdentityFromSshDetection(detectSshRemote(cwd));
}

// src/monitors/commit-watcher.ts
import { execFileSync as execFileSync5 } from "node:child_process";
import {
  closeSync as closeSync3,
  existsSync as existsSync7,
  openSync as openSync3,
  readSync as readSync2,
  statSync as statSync4,
  watch
} from "node:fs";
import { isAbsolute, resolve as resolve3 } from "node:path";
var GIT_EXEC_OPTS = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"]
};
var GIT_BODY_MAX_BUFFER = 64 * 1024 * 1024;
var ENUMERATE_WARN_THROTTLE_MS = 6e4;
var enumerateFailureLastWarnAt = /* @__PURE__ */ new Map();
var VALID_BRANCH_NAME = /^[A-Za-z0-9_\-./]+$/;
var VALID_SHA = /^[0-9a-f]{40}$/;
function isValidBranchName(name) {
  if (!VALID_BRANCH_NAME.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.endsWith(".lock")) return false;
  if (name.startsWith(".") || name.endsWith("/")) return false;
  if (name.includes("//")) return false;
  return true;
}
function resolveReflogPath(workingDir) {
  try {
    const raw = execFileSync5(
      "git",
      ["-C", workingDir, "rev-parse", "--git-path", "logs/HEAD"],
      GIT_EXEC_OPTS
    ).trim();
    if (!raw) return null;
    return isAbsolute(raw) ? raw : resolve3(workingDir, raw);
  } catch {
    return null;
  }
}
function readCommitMeta(workingDir, sha) {
  if (!VALID_SHA.test(sha)) return null;
  try {
    const out = execFileSync5(
      "git",
      [
        "-C",
        workingDir,
        "show",
        "-s",
        "--format=%H%x09%P%x09%aI%x09%an%x09%ae%x09%cI%x09%cn%x09%ce",
        sha
      ],
      GIT_EXEC_OPTS
    );
    const parts = out.trim().split("	");
    const [
      shaOut,
      parents,
      authoredAt,
      authorName,
      authorEmail,
      committedAt,
      committerName,
      committerEmail
    ] = parts;
    if (!shaOut || !VALID_SHA.test(shaOut)) return null;
    const parentShas = parents.trim() === "" ? [] : parents.trim().split(" ");
    const validParentShas = parentShas.filter((p) => VALID_SHA.test(p));
    let message = "";
    try {
      message = execFileSync5(
        "git",
        ["-C", workingDir, "log", "-1", "--format=%B", sha],
        { ...GIT_EXEC_OPTS, maxBuffer: GIT_BODY_MAX_BUFFER }
      ).trimEnd();
    } catch (bodyErr) {
      console.warn(
        `[commit-watcher] could not read message body for ${sha}: ${String(bodyErr)}`
      );
    }
    return {
      sha: shaOut,
      parentShas: validParentShas,
      parentSha: validParentShas[0] ?? null,
      authoredAt,
      authorName: authorName || null,
      authorEmail: authorEmail || null,
      committedAt: committedAt || null,
      committerName: committerName || null,
      committerEmail: committerEmail || null,
      message
    };
  } catch {
    return null;
  }
}
function enumerateBranchHeads(workingDir) {
  try {
    const out = execFileSync5(
      "git",
      [
        "-C",
        workingDir,
        "for-each-ref",
        "--format=%(refname:short) %(objectname)",
        "refs/heads/"
      ],
      GIT_EXEC_OPTS
    );
    enumerateFailureLastWarnAt.delete(workingDir);
    const result = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sep2 = trimmed.lastIndexOf(" ");
      if (sep2 < 0) continue;
      const branch = trimmed.slice(0, sep2);
      const sha = trimmed.slice(sep2 + 1);
      if (!isValidBranchName(branch)) continue;
      if (!VALID_SHA.test(sha)) continue;
      result.push({ branch, sha });
    }
    return result;
  } catch (err) {
    const now = Date.now();
    const lastWarn = enumerateFailureLastWarnAt.get(workingDir) ?? 0;
    if (now - lastWarn >= ENUMERATE_WARN_THROTTLE_MS) {
      enumerateFailureLastWarnAt.set(workingDir, now);
      console.warn(
        `[commit-watcher] enumerateBranchHeads failed for ${workingDir}: ${String(err)}`
      );
    }
    return [];
  }
}
function seedSeenWithCurrentHeads(workingDir, seen) {
  for (const { sha } of enumerateBranchHeads(workingDir)) {
    seen.add(sha);
  }
}
function resolveHeadBranch(workingDir) {
  try {
    const name = execFileSync5(
      "git",
      ["-C", workingDir, "rev-parse", "--abbrev-ref", "HEAD"],
      GIT_EXEC_OPTS
    ).trim();
    if (!name || name === "HEAD") return null;
    return isValidBranchName(name) ? name : null;
  } catch {
    return null;
  }
}
function readNewReflogShas(reflogPath, lastOffset) {
  let currentSize;
  try {
    currentSize = statSync4(reflogPath).size;
  } catch {
    return { shas: [], newOffset: lastOffset };
  }
  const readFrom = currentSize < lastOffset ? 0 : lastOffset;
  if (currentSize === readFrom) {
    return { shas: [], newOffset: currentSize };
  }
  const chunkLen = currentSize - readFrom;
  const buf = Buffer.allocUnsafe(chunkLen);
  let fd;
  try {
    fd = openSync3(reflogPath, "r");
  } catch {
    return { shas: [], newOffset: lastOffset };
  }
  let totalRead = 0;
  try {
    while (totalRead < chunkLen) {
      const n = readSync2(
        fd,
        buf,
        totalRead,
        chunkLen - totalRead,
        readFrom + totalRead
      );
      if (n === 0) break;
      totalRead += n;
    }
  } finally {
    try {
      closeSync3(fd);
    } catch {
    }
  }
  const chunk = buf.toString("utf8", 0, totalRead);
  const shas = [];
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace < 0) continue;
    const rest = trimmed.slice(firstSpace + 1);
    const secondSpace = rest.indexOf(" ");
    const newSha = secondSpace < 0 ? rest : rest.slice(0, secondSpace);
    if (VALID_SHA.test(newSha)) {
      shas.push(newSha);
    }
  }
  return { shas, newOffset: currentSize };
}
async function startCommitWatcher(input) {
  const logsHeadFileOrNull = resolveReflogPath(input.workingDir);
  if (!logsHeadFileOrNull || !existsSync7(logsHeadFileOrNull)) {
    throw new Error(
      `No git reflog at ${logsHeadFileOrNull ?? `${input.workingDir}/.git/logs/HEAD`}`
    );
  }
  const logsHeadFile = logsHeadFileOrNull;
  const watchers = [];
  const seen = /* @__PURE__ */ new Set();
  seedSeenWithCurrentHeads(input.workingDir, seen);
  let lastOffset = statSync4(logsHeadFile).size;
  let processing = false;
  let pending = false;
  async function processReflogChunk() {
    if (processing) {
      pending = true;
      return;
    }
    processing = true;
    try {
      do {
        pending = false;
        const { shas, newOffset } = readNewReflogShas(logsHeadFile, lastOffset);
        lastOffset = newOffset;
        if (shas.length === 0) continue;
        const branchHeads = enumerateBranchHeads(input.workingDir);
        const shaToB = new Map(
          branchHeads.map(({ sha, branch }) => [sha, branch])
        );
        const headBranch = resolveHeadBranch(input.workingDir);
        for (const sha of shas) {
          if (seen.has(sha)) continue;
          seen.add(sha);
          const meta = readCommitMeta(input.workingDir, sha);
          if (!meta) continue;
          const branch = shaToB.get(sha) ?? headBranch ?? "HEAD";
          input.onCommit({ ...meta, branch, workingDir: input.workingDir }).catch(() => {
          });
        }
      } while (pending);
    } finally {
      processing = false;
    }
  }
  const watcher = watch(logsHeadFile, { persistent: true }, () => {
    processReflogChunk().catch(() => {
    });
  });
  watchers.push(watcher);
  return async function stop() {
    for (const w of watchers) w.close();
  };
}

// src/skills/spellguard-reset.ts
import { rmSync as rmSync5 } from "node:fs";
function supersededMessage(cause) {
  if (cause === "reassigned") {
    return "This agent was reassigned to another user; its local credentials were cleared and you no longer own it.";
  }
  if (cause === "attached_elsewhere") {
    return "This machine was disconnected because this agent was attached on another machine. Its local credentials were cleared \u2014 run /spellguard-setup and select it to use it here again.";
  }
  return "This agent's credentials were cleared \u2014 run /spellguard-setup to reconnect.";
}
function wipeSupersededCredentials(args) {
  const message = supersededMessage(args.cause);
  const configPath = args.configPath ?? defaultConfigPath();
  (args.markConfigSupersededImpl ?? ((m) => markConfigSuperseded(m, configPath)))(message);
  if (args.envFilePath) {
    try {
      (args.clearGitConfigEnvImpl ?? clearGitConfigEnv)(args.envFilePath);
    } catch {
    }
  }
  if (args.ghConfigDir) {
    try {
      (args.clearGhSessionConfigImpl ?? clearGhSessionConfig)(args.ghConfigDir);
    } catch {
    }
  }
  if (args.legacyGhTokenFile) {
    try {
      (args.clearGhTokenFileImpl ?? ((path) => rmSync5(path, { force: true })))(args.legacyGhTokenFile);
    } catch {
    }
  }
}

// bin/spellguard-credential-daemon.ts
import { fileURLToPath as fileURLToPath3 } from "node:url";
var GIT_DIFF_MAX_BUFFER = 64 * 1024 * 1024;
function parseArgs(argv) {
  const args = argv.slice(2);
  const agentId = args[0];
  if (!agentId) {
    process.stderr.write(
      "spellguard-credential-daemon: missing required argument <agentId>\n"
    );
    process.exit(1);
  }
  let configDir = defaultConfigDir();
  const configDirIdx = args.indexOf("--config-dir");
  if (configDirIdx !== -1 && args[configDirIdx + 1]) {
    configDir = args[configDirIdx + 1];
  }
  let cwd = null;
  const cwdIdx = args.indexOf("--cwd");
  if (cwdIdx !== -1 && args[cwdIdx + 1]) {
    cwd = args[cwdIdx + 1];
  }
  const instanceIdIdx = args.indexOf("--instance-id");
  const instanceId = instanceIdIdx !== -1 && args[instanceIdIdx + 1] ? args[instanceIdIdx + 1] : randomUUID3();
  const scriptPath = process.argv[1] ?? fileURLToPath3(import.meta.url);
  const artifactIdIdx = args.indexOf("--artifact-id");
  const artifactId = artifactIdIdx !== -1 && args[artifactIdIdx + 1] ? args[artifactIdIdx + 1] : daemonArtifactId(scriptPath);
  return { agentId, configDir, cwd, instanceId, artifactId, scriptPath };
}
function agentsDir(configDir) {
  return join10(configDir, "agents");
}
function computeNeedsLoginRelay(opts) {
  return opts.relayEnabled && opts.autoStart && !opts.oauthTokenEnv && !opts.oauthTokenFileExists;
}
function makeLoginCodeDedupe() {
  let lastAccepted = null;
  return {
    accept(code) {
      if (code === lastAccepted) {
        return false;
      }
      lastAccepted = code;
      return true;
    },
    reset() {
      lastAccepted = null;
    }
  };
}
function pidFilePath(configDir, agentId) {
  return join10(agentsDir(configDir), `${agentId}.pid`);
}
function logFilePath(configDir, agentId) {
  return join10(agentsDir(configDir), `${agentId}.log`);
}
function readPidFileSync(path) {
  if (!existsSync8(path)) return null;
  try {
    const raw = readFileSync5(path, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
var _logPath = null;
function log(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  if (_logPath) {
    try {
      appendFileSync3(_logPath, line, { encoding: "utf-8", mode: 384 });
    } catch {
    }
  } else {
    process.stderr.write(line);
  }
}
function acquirePidSlot(pidPath, agentId, logFn = log) {
  let fd;
  try {
    fd = openSync4(pidPath, "wx", 384);
  } catch (err) {
    const code = err.code;
    if (code === "EEXIST") {
      const existingPid = readPidFileSync(pidPath);
      if (existingPid !== null && isProcessAlive(existingPid)) {
        return false;
      }
      try {
        unlinkSync2(pidPath);
      } catch {
      }
      try {
        fd = openSync4(pidPath, "wx", 384);
      } catch {
        return false;
      }
    } else {
      throw err;
    }
  }
  chmodSync6(pidPath, 384);
  const pidStr = String(process.pid);
  writeSync2(fd, pidStr, 0, "utf-8");
  closeSync4(fd);
  logFn(`daemon started (pid=${process.pid}, agentId=${agentId})`);
  return true;
}
function exitFailure(pidPath, msg) {
  log(msg);
  try {
    unlinkSync2(pidPath);
  } catch {
  }
  process.exit(1);
}
function loadConfig(configPath, pidPath) {
  const readResult = readConfig(configPath);
  if (!readResult.config) {
    exitFailure(
      pidPath,
      `config not found or unreadable (reason=${readResult.reason ?? "unknown"}); exiting`
    );
  }
  const config = readResult.config;
  if (!config.agentSecret)
    exitFailure(
      pidPath,
      "config missing agentSecret; re-run /spellguard-setup to provision a new credential"
    );
  if (!config.agentId) exitFailure(pidPath, "config missing agentId; exiting");
  return config;
}
function captureGitShowDiff(params) {
  const { sha, gitRoot, logFn } = params;
  const execGitShow = params.execGitShow ?? ((s, root) => execFileSync6("git", ["show", s], {
    cwd: root,
    encoding: "utf8",
    // Explicit 64 MB maxBuffer — identical to GIT_BODY_MAX_BUFFER
    // in commit-watcher.ts. Without this the Node default of
    // 1 MB is used, and a large merge commit throws ENOBUFS which was
    // previously swallowed silently.
    maxBuffer: GIT_DIFF_MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"]
  }));
  try {
    const out = execGitShow(sha, gitRoot);
    return parseShowDiff(out);
  } catch (err) {
    logFn(`[daemon] git show failed for ${sha} (diff skipped): ${String(err)}`);
    return null;
  }
}
function collectExpiryEntries(config, configDir) {
  const activeV5 = readActiveGithubGrantExpiryEntries(
    configDir,
    config.agentId
  );
  if (activeV5.state === "unavailable") return [];
  if (activeV5.state === "available") {
    return [
      ...new Map(
        activeV5.entries.map((entry) => [entry.scopedTokenId, entry])
      ).values()
    ];
  }
  const keyed = config.githubCredentials;
  if (keyed && Object.keys(keyed).length > 0) {
    const out = [];
    for (const e of Object.values(keyed)) {
      if (e.revoked || !e.expiresAt || !e.scopedTokenId) continue;
      out.push({ scopedTokenId: e.scopedTokenId, expiresAt: e.expiresAt });
    }
    return out;
  }
  const { expiresAt, scopedTokenId } = config;
  return expiresAt && scopedTokenId ? [{ scopedTokenId, expiresAt }] : [];
}
var GITHUB_REISSUE_BACKOFF_INITIAL_MS = 6e4;
var GITHUB_REISSUE_BACKOFF_MAX_MS = 30 * 6e4;
function makeGithubReissueRetryState() {
  return {
    inFlight: false,
    nextAttemptAtMs: 0,
    backoffMs: GITHUB_REISSUE_BACKOFF_INITIAL_MS
  };
}
function resetGithubReissueRetryState(state) {
  state.inFlight = false;
  state.nextAttemptAtMs = 0;
  state.backoffMs = GITHUB_REISSUE_BACKOFF_INITIAL_MS;
}
async function handleGithubGrantBundle(frame, configDir, state, deps) {
  await applyGithubGrantBundle(configDir, frame);
  const localConfig = deps.readConfigImpl();
  const managed = (deps.isManagedBox ?? isManagedBox)();
  if (localConfig.config && !managed) {
    if (deps.envFilePath) {
      writeGitConfigEnv({
        envFilePath: deps.envFilePath,
        gitAuthorName: localConfig.config.gitAuthorName,
        gitAuthorEmail: localConfig.config.gitAuthorEmail,
        ghConfigDir: deps.ghConfigDir,
        helperPath: deps.helperPath,
        sshRewriteRepo: deps.sshRewriteRepo
      });
    }
    const primary = frame.credentials[0];
    if (deps.ghConfigDir) {
      if (primary) {
        writeGhSessionConfig({
          dir: deps.ghConfigDir,
          token: primary.scoped_token
        });
      } else {
        clearGhSessionConfig(deps.ghConfigDir);
      }
    }
  }
  if (!frame.credentials.some((credential) => credential.scoped_token)) {
    return false;
  }
  const configPath = join10(configDir, "config.json");
  const current = readConfig(configPath);
  if (current.config?.githubReissue?.pending) {
    writeConfig({ ...current.config, githubReissue: void 0 }, configPath);
  }
  resetGithubReissueRetryState(state);
  return true;
}
function checkGithubReissue(clientRef, cfgPath, state, logFn = log) {
  const cur = readConfig(cfgPath);
  if (!cur.config?.githubReissue?.pending || cur.config.revoked) {
    resetGithubReissueRetryState(state);
    return false;
  }
  const now = Date.now();
  if (state.inFlight || now < state.nextAttemptAtMs) return false;
  const retryDelay = state.backoffMs;
  state.inFlight = true;
  state.nextAttemptAtMs = now + retryDelay;
  state.backoffMs = Math.min(retryDelay * 2, GITHUB_REISSUE_BACKOFF_MAX_MS);
  logFn(
    `requesting fresh GitHub credential issuance (next retry in ${Math.round(retryDelay / 1e3)}s)`
  );
  void clientRef.requestRefresh({ reason: "manual", provider: "github" }).catch((err) => {
    if (err instanceof Error && err.message !== "client_closed") {
      logFn(`GitHub credential issuance request failed: ${err.message}`);
    }
  }).finally(() => {
    state.inFlight = false;
  });
  return true;
}
function checkExpiryAndRefresh(clientRef, cfgPath, inFlight, logFn = log, shutdownFn, githubReissueState = makeGithubReissueRetryState()) {
  const cur = readConfig(cfgPath);
  if (!cur.config) return false;
  if (cur.config.revoked) {
    if (!cur.config.agentId || !cur.config.agentSecret) {
      logFn("credential is revoked and no agent identity remains; exiting");
      if (shutdownFn) {
        shutdownFn();
        return false;
      }
      process.exit(0);
    }
    logFn(
      "credential is revoked; skipping refresh and staying connected for a replacement credential"
    );
    return false;
  }
  const entries = collectExpiryEntries(cur.config, dirname6(cfgPath));
  const nearExpiryMs = 10 * 60 * 1e3;
  let triggeredAny = checkGithubReissue(
    clientRef,
    cfgPath,
    githubReissueState,
    logFn
  );
  for (const entry of entries) {
    if (inFlight.has(entry.scopedTokenId)) continue;
    const msUntilExpiry = new Date(entry.expiresAt).getTime() - Date.now();
    if (msUntilExpiry >= nearExpiryMs) continue;
    inFlight.add(entry.scopedTokenId);
    triggeredAny = true;
    void clientRef.requestRefresh({
      reason: "expiry",
      provider: "github",
      superseded_scoped_token_id: entry.scopedTokenId
    }).catch((err) => {
      if (err instanceof Error && err.message !== "client_closed") {
        logFn(`expiry refresh failed: ${err.message}`);
      }
    }).finally(() => {
      inFlight.delete(entry.scopedTokenId);
    });
  }
  return triggeredAny;
}
async function startLoginRelay(deps) {
  const tag = deps.label ? ` (${deps.label})` : "";
  try {
    const spawnPty = await deps.makeSpawner();
    const result = await deps.runRelay({
      spawnPty,
      sendUpdate: deps.sendUpdate,
      markAuthenticated: deps.markAuthenticated,
      isLoggedIn: deps.isLoggedIn,
      waitForCode: deps.waitForCode,
      signal: deps.signal
    });
    deps.logFn(`login relay${tag} completed ok=${result.ok}`);
    return result;
  } catch (err) {
    const detail = err?.message ?? String(err);
    if (!deps.signal.aborted) {
      try {
        deps.sendUpdate({
          state: "failed",
          message: `login relay failed to start: ${detail}`
        });
      } catch (sendErr) {
        deps.logFn(
          `login relay${tag} failed-state report could not be sent: ${sendErr?.message ?? String(sendErr)}`
        );
      }
    }
    deps.logFn(`login relay${tag} error: ${detail}`);
    return null;
  }
}
function buildSecretModeCredentials(cfg) {
  return {
    mode: "secret",
    agentId: cfg.agentId,
    agentSecret: cfg.agentSecret,
    framework: FRAMEWORK
  };
}
function credentialState(config, configDir) {
  if (config.revoked) return "revoked";
  const entries = collectExpiryEntries(config, configDir);
  if (entries.length === 0) return "missing";
  const now = Date.now();
  const expiries = entries.map((entry) => Date.parse(entry.expiresAt));
  if (expiries.some((expiry) => !Number.isFinite(expiry) || expiry <= now))
    return "expired";
  if (expiries.some((expiry) => expiry - now <= 10 * 6e4))
    return "near_expiry";
  return "valid";
}
async function main() {
  const { agentId, configDir, cwd, instanceId, artifactId, scriptPath } = parseArgs(process.argv);
  mkdirSync7(agentsDir(configDir), { recursive: true });
  const pidPath = pidFilePath(configDir, agentId);
  _logPath = logFilePath(configDir, agentId);
  writeFileSync6(_logPath, "", { flag: "a", mode: 384 });
  chmodSync6(_logPath, 384);
  if (!acquirePidSlot(pidPath, agentId)) {
    log("another daemon instance is already running; exiting");
    process.exit(0);
  }
  const configPath = join10(configDir, "config.json");
  const config = loadConfig(configPath, pidPath);
  const managedBox = isManagedBox();
  const health = startDaemonHealthReporter({
    agentId,
    configDir,
    scriptPath,
    artifactId,
    instanceId,
    credentialState: credentialState(config, configDir)
  });
  try {
    writeGitTokensFile(config, configDir);
  } catch (err) {
    log(`startup git-tokens regeneration failed: ${String(err)}`);
  }
  const ghConfigDir = ghConfigDirPath(configDir, agentId);
  if (!managedBox) {
    try {
      const activeV5 = readActiveGithubGrantPrimaryToken(configDir, agentId);
      const token = activeV5.state === "available" ? activeV5.token : activeV5.state === "absent" ? config.scopedToken : null;
      if (token) {
        writeGhSessionConfig({ dir: ghConfigDir, token });
      } else {
        clearGhSessionConfig(ghConfigDir);
      }
    } catch (err) {
      log(`startup GitHub projection regeneration failed: ${String(err)}`);
    }
  }
  const envFilePath = process.env.CLAUDE_ENV_FILE ?? "";
  if (!envFilePath) {
    log("CLAUDE_ENV_FILE not set; credential env-file updates will be skipped");
  }
  const readCfg = () => readConfig(configPath);
  const writeCfg = (cfg) => writeConfig(cfg, configPath);
  let handshakeAuthRejections = 0;
  const sshRewriteRepo = cwd ? resolveSshRewriteRepo(cwd) : void 0;
  const handlerDeps = {
    envFilePath,
    writeConfigImpl: writeCfg,
    markConfigRevokedImpl: () => markConfigRevoked(configPath),
    markConfigSuspendedImpl: () => markConfigSuspended(configPath),
    readConfigImpl: readCfg,
    ghConfigDir,
    // Legacy-cleanup only: the revoke / 4401 paths unlink a pre-#767 plaintext
    // `<configDir>/gh-token` an older plugin version left behind.
    configDir,
    helperPath: ensureStableHelper(configDir),
    sshRewriteRepo
  };
  const onSeqAdvanced = (seq) => {
    const cur = readCfg();
    if (cur.config) writeCfg({ ...cur.config, lastServerSeq: seq });
  };
  const onKnownCredentialsChanged = (known) => {
    const cur = readCfg();
    if (cur.config) writeCfg({ ...cur.config, knownCredentials: known });
  };
  const expiryInFlight = /* @__PURE__ */ new Set();
  const githubReissueState = makeGithubReissueRetryState();
  let shutdown = () => process.exit(0);
  const oauthTokenFile = join10(homedir4(), ".claude-oauth-token");
  const loginRelayEnv = process.env.SPELLGUARD_LOGIN_RELAY;
  const loginRelayEnabled = loginRelayEnv === "1" || loginRelayEnv === "wait";
  const loginRelayAutoStart = loginRelayEnv === "1";
  const needsLoginRelay = computeNeedsLoginRelay({
    relayEnabled: loginRelayEnabled,
    autoStart: loginRelayAutoStart,
    oauthTokenEnv: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    oauthTokenFileExists: existsSync8(oauthTokenFile)
  });
  const AUTHORIZED_REASSERT_DELAYS_MS = [2500, 6e3, 15e3];
  function scheduleAuthorizedReassert() {
    for (const delay of AUTHORIZED_REASSERT_DELAYS_MS) {
      setTimeout(() => {
        if (existsSync8(oauthTokenFile)) {
          client.sendLoginRelayUpdate({ state: "authorized" });
        }
      }, delay);
    }
  }
  let pendingCodeResolve = null;
  let bufferedCode = null;
  const loginCodeDedupe = makeLoginCodeDedupe();
  let relayAbortController = null;
  function makeWaitForCode() {
    return new Promise((resolve4) => {
      if (bufferedCode !== null) {
        const code = bufferedCode;
        bufferedCode = null;
        resolve4(code);
        return;
      }
      pendingCodeResolve = resolve4;
    });
  }
  const client = new AgentControlClient({
    apiBaseUrl: config.spellguardBaseUrl,
    agentId: config.agentId,
    // Phase C: this plugin can hold one GitHub credential per GitHub org
    // simultaneously (org-keyed store + git-tokens routing + per-credential
    // daemon refresh), so it advertises the github_multi_org capability. The
    // server relaxes Phase B's single-org-per-agent restriction only for
    // capable agents.
    capabilities: ["github_multi_org", "github_grant_bundle_v1"],
    initialLastServerSeq: config.lastServerSeq,
    // Replay the cached projection so the first Resume after restart
    // matches the server's live row set and divergence detection stays quiet.
    initialKnownCredentials: config.knownCredentials,
    // R2-10: the accessor threads THIS daemon's own `framework` onto the
    // secret-mode connect (see buildSecretModeCredentials) so per-framework
    // login attribution works on a multi-framework box.
    credentials: () => buildSecretModeCredentials(config),
    onCredentialDelivered: (frame) => {
      if (handleCredentialUpdate(frame, handlerDeps)) {
        resetGithubReissueRetryState(githubReissueState);
        const current = readCfg();
        if (current.config)
          health.setCredentialState(credentialState(current.config, configDir));
      }
    },
    onCredentialRotated: (frame) => {
      if (handleCredentialUpdate(frame, handlerDeps)) {
        resetGithubReissueRetryState(githubReissueState);
        const current = readCfg();
        if (current.config)
          health.setCredentialState(credentialState(current.config, configDir));
      }
    },
    onGithubGrantsBundle: async (frame) => {
      await handleGithubGrantBundle(
        frame,
        configDir,
        githubReissueState,
        handlerDeps
      );
      const current = readCfg();
      if (current.config)
        health.setCredentialState(credentialState(current.config, configDir));
    },
    onCredentialRevoked: (frame) => {
      const recoverable = handleCredentialRevoked(frame, handlerDeps);
      const current = readCfg();
      if (current.config)
        health.setCredentialState(credentialState(current.config, configDir));
      log(
        recoverable ? "credential_revoked handled; daemon staying alive for sibling or replacement credentials" : "credential_revoked arrived without readable local config; daemon remains connected"
      );
    },
    onCredentialRevokeSettled: () => {
      checkGithubReissue(client, configPath, githubReissueState, log);
    },
    // Persist config_updated descriptors to the local config-store.
    onConfigUpdated: (frame) => handleConfigUpdate(frame, handlerDeps),
    // FIND-DA28 — on every (re)connect, RE-ASSERT the terminal login state when
    // a token already exists on disk. The relay's one-shot
    // login_relay_update{authorized} is fire-and-forget; if the channel was
    // mid-churn at login completion (e.g. a credential admin_reissue /
    // credential_request_timeout in the same window) the update is silently
    // dropped and — because `authorized` is terminal — nothing ever re-sends it,
    // so the dashboard sticks on "Authorize Claude" even though the box is
    // authenticated. A token on disk == login succeeded, so re-send `authorized`
    // (idempotent: the DO just re-persists it) to heal a dropped update AND to
    // reflect the authed state after a daemon restart (where the relay does not
    // re-run, per the needsLoginRelay gate). No token → no-op (a real login still
    // pending must not be reported authorized).
    onConnect: () => {
      health.setTransport("connected");
      checkGithubReissue(client, configPath, githubReissueState, log);
      if (!existsSync8(oauthTokenFile)) return;
      scheduleAuthorizedReassert();
    },
    onSeqAdvanced: (seq) => {
      handshakeAuthRejections = 0;
      return onSeqAdvanced(seq);
    },
    onKnownCredentialsChanged,
    onFatalClose: (code, reason) => {
      handleAuthFailedClose(code, handlerDeps);
      exitFailure(
        pidPath,
        `fatal close: code=${code} reason=${reason}; exiting`
      );
    },
    // P2-T6 (FR-10/NR-3/D11): the server superseded this agent's secret with a
    // 4409 close — a DELIBERATE move (attached on another machine) or reassign.
    // This is the SOLE trigger for the local self-wipe; the shared client
    // dispatches it ONLY on 4409 and never alongside onFatalClose, so a generic
    // auth/transient failure can never reach this path (guardrail confirmed in
    // packages/agent-control/src/client.ts close handler). Clear THIS agent's
    // on-disk credentials and persist the cause-specific message so the next
    // SessionStart re-surfaces it (the wipe runs in the background daemon with
    // no interactive session open). Then shut the daemon down cleanly — the
    // client has already closed the socket.
    // #1348: the agent is quarantined. Drop what this daemon placed and keep
    // running: the client keeps the identity and reconnects on its suspended
    // backoff, and the reconnect a release lets through resumes normally.
    onSuspended: ({ reason, retryInMs }) => {
      log(
        `agent suspended (reason=${reason}); credentials dropped, retrying in ${Math.round(retryInMs / 1e3)}s`
      );
      handleSuspended(handlerDeps);
    },
    onCredentialSuperseded: (cause) => {
      log(`credential superseded (cause=${cause}); wiping local credentials`);
      try {
        wipeSupersededCredentials({
          cause,
          configPath,
          envFilePath,
          ghConfigDir,
          legacyGhTokenFile: join10(configDir, "gh-token")
        });
      } catch (err) {
        log(`self-wipe failed: ${err?.message ?? String(err)}`);
      }
      shutdown();
    },
    onInfo: (message) => {
      log(`info: ${message}`);
    },
    // REQ-003: receive the auth code from the control plane during the
    // headless login relay flow, and re-run the relay on operator request.
    //
    // These handlers are ALWAYS registered — NOT gated on `needsLoginRelay`.
    // Only the INITIAL auto-start of the relay (below) is gated on
    // `needsLoginRelay`; handler REGISTRATION is not. They are cheap no-ops
    // until a frame actually arrives. Gating registration was a silent bug:
    // on a boot where a Claude token already existed (`needsLoginRelay ===
    // false`) the handlers were never wired, so an operator clicking
    // "Restart login" in the dashboard was dropped on the floor — the box
    // never re-ran `claude auth login`. A login_restart is an explicit
    // operator re-auth request and must work even when a token already
    // exists (the fresh relay re-marks it via defaultMarkAuthenticated).
    onLoginCode: (frame) => {
      if (!loginCodeDedupe.accept(frame.code)) {
        log("login_code received (duplicate, ignored)");
        return;
      }
      log("login_code received from control plane");
      if (pendingCodeResolve) {
        const resolve4 = pendingCodeResolve;
        pendingCodeResolve = null;
        resolve4(frame.code);
      } else {
        bufferedCode = frame.code;
      }
    },
    onLoginRestart: () => {
      log("login_restart received \u2014 re-running login relay");
      if (relayAbortController) {
        relayAbortController.abort();
      }
      relayAbortController = new AbortController();
      const signal = relayAbortController.signal;
      pendingCodeResolve = null;
      bufferedCode = null;
      loginCodeDedupe.reset();
      void startLoginRelay({
        makeSpawner: makeNodePtySpawner,
        runRelay: runLoginRelay,
        sendUpdate: (update) => client.sendLoginRelayUpdate(update),
        markAuthenticated: defaultMarkAuthenticated,
        isLoggedIn: defaultIsLoggedIn,
        waitForCode: makeWaitForCode,
        signal,
        logFn: log,
        label: "restart"
      }).then((r) => {
        if (r?.ok) scheduleAuthorizedReassert();
      });
    },
    onError: (err) => {
      health.setTransport("error", err.message);
      log(`error: ${err.message}`);
      if (isHandshakeAuthRejection(err)) {
        handshakeAuthRejections++;
        if (handshakeAuthRejections >= 3) {
          handleAuthFailedClose(4401, handlerDeps);
          exitFailure(
            pidPath,
            `websocket upgrade rejected with auth error ${handshakeAuthRejections}x; treating as deleted/revoked agent and exiting`
          );
        }
      } else {
        handshakeAuthRejections = 0;
      }
    }
  });
  const expiryInterval = setInterval(() => {
    const current = readCfg();
    if (current.config) {
      health.setCredentialState(credentialState(current.config, configDir));
    }
    checkExpiryAndRefresh(
      client,
      configPath,
      expiryInFlight,
      log,
      shutdown,
      githubReissueState
    );
  }, 6e4);
  let commitWatcherStop;
  if (cwd) {
    commitWatcherStop = await maybeStartCommitWatcher({
      cwd,
      agentId: config.agentId,
      agentSecret: config.agentSecret,
      baseUrl: config.spellguardBaseUrl,
      log
    });
  }
  let shutdownInProgress = false;
  shutdown = () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    log("shutting down");
    clearInterval(expiryInterval);
    if (commitWatcherStop) {
      commitWatcherStop().catch((err) => {
        log(
          `commit watcher stop failed: ${err?.message ?? String(err)}`
        );
      });
    }
    client.close();
    health.close();
    try {
      unlinkSync2(pidPath);
    } catch {
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  client.start();
  health.markReady();
  if (needsLoginRelay) {
    log(
      "starting login relay (SPELLGUARD_LOGIN_RELAY=1, no token in env or on disk)"
    );
    relayAbortController = new AbortController();
    const initialSignal = relayAbortController.signal;
    void startLoginRelay({
      makeSpawner: makeNodePtySpawner,
      runRelay: runLoginRelay,
      sendUpdate: (update) => client.sendLoginRelayUpdate(update),
      markAuthenticated: defaultMarkAuthenticated,
      isLoggedIn: defaultIsLoggedIn,
      waitForCode: makeWaitForCode,
      signal: initialSignal,
      logFn: log
    }).then((r) => {
      if (r?.ok) scheduleAuthorizedReassert();
    });
  } else if (loginRelayEnabled && !loginRelayAutoStart) {
    log(
      "login relay ready (SPELLGUARD_LOGIN_RELAY=wait) \u2014 not auto-started; waiting for the operator to start login"
    );
  } else if (loginRelayEnabled) {
    log(
      "login relay skipped \u2014 Claude already authorized (token in env or on disk)"
    );
  }
  checkExpiryAndRefresh(
    client,
    configPath,
    expiryInFlight,
    log,
    shutdown,
    githubReissueState
  );
}
async function maybeStartCommitWatcher(args) {
  if (process.env.SPELLGUARD_COMMIT_OBSERVATIONS === "0") return void 0;
  let remoteUrl;
  try {
    remoteUrl = execSync("git config --get remote.origin.url", {
      cwd: args.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).toString().trim();
    if (!remoteUrl) return void 0;
  } catch {
    return void 0;
  }
  const gitRoot = resolveGitRoot(args.cwd);
  const probe = checkLogAllRefUpdates(args.cwd);
  if (probe.shouldWarn) {
    args.log(
      "commit watcher depends on `core.logAllRefUpdates=true` (currently disabled in this repo). Commit observations may be lost until the config is restored: `git config core.logAllRefUpdates true`."
    );
  }
  const sessionId = randomUUID3();
  try {
    const stop = await startCommitWatcher({
      workingDir: gitRoot,
      onCommit: async (event) => {
        const store = openEditStore({
          rootDir: join10(homedir4(), ".spellguard")
        });
        try {
          await emitCommitObservation({
            store,
            diffProvider: async (sha) => {
              return captureGitShowDiff({ sha, gitRoot, logFn: args.log }) ?? {};
            },
            fetch,
            apiBase: args.baseUrl,
            agentId: args.agentId,
            agentSecret: args.agentSecret,
            workingDir: gitRoot,
            remoteUrl,
            commitEvent: event,
            sessionContext: { sessionId, agentId: args.agentId }
          });
        } finally {
          store.close();
        }
      }
    });
    return stop;
  } catch (err) {
    args.log(
      `commit watcher not started (${err?.message ?? "unknown"}).`
    );
    return void 0;
  }
}
var _thisFile = fileURLToPath3(import.meta.url);
var _entryPoint = process.argv[1] ?? "";
var _isEntryPoint = _entryPoint !== "" && (_thisFile === _entryPoint || _thisFile.endsWith(_entryPoint.replace(/\\/g, "/")));
if (_isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(
      `spellguard-credential-daemon: unhandled error: ${String(err)}
`
    );
    process.exit(1);
  });
}
export {
  GITHUB_REISSUE_BACKOFF_INITIAL_MS,
  GITHUB_REISSUE_BACKOFF_MAX_MS,
  GIT_DIFF_MAX_BUFFER,
  acquirePidSlot,
  buildSecretModeCredentials,
  captureGitShowDiff,
  checkExpiryAndRefresh,
  checkGithubReissue,
  computeNeedsLoginRelay,
  credentialState,
  handleGithubGrantBundle,
  logFilePath,
  makeGithubReissueRetryState,
  makeLoginCodeDedupe,
  pidFilePath,
  resetGithubReissueRetryState,
  startLoginRelay
};
