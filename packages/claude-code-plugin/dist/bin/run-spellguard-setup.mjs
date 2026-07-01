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
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
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
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
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
      var prebuild = resolve3(dir);
      if (prebuild) return prebuild;
      var nearby = resolve3(path.dirname(process.execPath));
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
      function resolve3(dir2) {
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
      var extension = arr.pop();
      var tags = { file, specificity: 0 };
      if (extension !== "node") return;
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
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
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
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate = class {
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
       * @param {Boolean} [isServer=false] Create the instance in either server or
       *     client mode
       * @param {Number} [maxPayload=0] The maximum allowed message length
       */
      constructor(options, isServer, maxPayload) {
        this._maxPayload = maxPayload | 0;
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._isServer = !!isServer;
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
    module.exports = PerMessageDeflate;
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
    var PerMessageDeflate = require_permessage_deflate();
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
        if (compressed && !this._extensions[PerMessageDeflate.extensionName]) {
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
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
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
    var PerMessageDeflate = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
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
          } else {
            buf.set(data, 2);
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
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
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
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
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
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
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
      return Object.keys(extensions).map((extension) => {
        let configurations = extensions[extension];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension].concat(
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
    var { randomBytes: randomBytes2, createHash } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL } = __require("url");
    var PerMessageDeflate = require_permessage_deflate();
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
    var kAborted = Symbol("kAborted");
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
        if (this._extensions[PerMessageDeflate.extensionName]) {
          this._extensions[PerMessageDeflate.extensionName].cleanup();
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
        if (!this._extensions[PerMessageDeflate.extensionName]) {
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
      if (address instanceof URL) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL(address);
        } catch (e) {
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
      const key = randomBytes2(16).toString("base64");
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
        perMessageDeflate = new PerMessageDeflate(
          opts.perMessageDeflate !== true ? opts.perMessageDeflate : {},
          false,
          opts.maxPayload
        );
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate.extensionName]: perMessageDeflate.offer()
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
            addr = new URL(location, address);
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
        const digest = createHash("sha1").update(key + GUID).digest("base64");
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
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
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
          ws.once("open", function open() {
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
          ws.once("open", function open() {
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
    var { createHash } = __require("crypto");
    var extension = require_extension();
    var PerMessageDeflate = require_permessage_deflate();
    var subprotocol = require_subprotocol();
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
            protocols = subprotocol.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate(
            this.options.perMessageDeflate,
            true,
            this.options.maxPayload
          );
          try {
            const offers = extension.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate.extensionName]);
              extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
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
        const digest = createHash("sha1").update(key + GUID).digest("base64");
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
        if (extensions[PerMessageDeflate.extensionName]) {
          const params = extensions[PerMessageDeflate.extensionName].params;
          const value = extension.format({
            [PerMessageDeflate.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
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
    return new Promise((resolve3) => {
      setTimeout(resolve3, this._getNextDelay());
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
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;

// ../agent-control/dist/index.mjs
import { hostname } from "node:os";

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
var KNOWN_SERVER_FRAME_TYPES = /* @__PURE__ */ new Set([
  "hello",
  "credential_delivered",
  "credential_rotated",
  "credential_revoked",
  "config_updated",
  "ack",
  "error",
  "resume_window_exceeded",
  "login_code",
  "login_restart"
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
  if (obj.type === "login_code") {
    if (typeof obj.code !== "string" || obj.code.length === 0) return null;
  }
  return obj;
}
var AGENT_CONTROL_CLOSE_CODES = {
  NORMAL: 1e3,
  INTERNAL_ERROR: 1011,
  BOOTSTRAP_ERROR: 4400,
  AUTH_FAILED: 4401,
  AGENT_OWNERSHIP: 4403,
  RESUME_WINDOW_EXCEEDED: 4413,
  ALREADY_CONNECTED: 4429,
  /**
   * Set ONLY on a deliberate move/re-bootstrap rotation; the sole trigger
   * for the plugin self-wipe. The close reason string is one of
   * `AUTH_SUPERSEDED_CLOSE_REASONS` — use that constant to match on it.
   */
  AUTH_SUPERSEDED: 4409
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
  #ps = null;
  #closed = false;
  #lastServerSeq;
  #knownCredentials;
  #firstConnect = true;
  #pendingRequests = /* @__PURE__ */ new Map();
  // Serializes refresh requests because `credential_delivered` carries no
  // `client_msg_id` correlation: with two requests in flight, the dispatcher
  // would resolve them out-of-order. This serialization can be dropped if the
  // protocol later grows an `in_response_to` correlation field.
  #refreshChain = Promise.resolve();
  // Rotation-fallback timers. Key = seq of the config_updated frame.
  // Cleared when a credential_rotated arrives before the 10s window expires.
  #rotationTimers = /* @__PURE__ */ new Map();
  // FIND-DA22 — keepalive heartbeat state. The timer fires every
  // heartbeatIntervalMs; #lastPongAt tracks the last observed 'pong' (clock
  // value, via the injectable #now()) so the timer can detect a zombie socket.
  #heartbeatTimer = null;
  #lastPongAt = 0;
  /** Open the socket. Subsequent reconnects are automatic. */
  start() {
    if (this.#closed || this.#ps) return;
    const BaseImpl = this.opts.WebSocketImpl ?? wrapper_default;
    const Impl = makeErrorSafeWebSocket(BaseImpl, this.opts.upgradeHeaders);
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
      void this.#onOpen();
    });
    ps.addEventListener("message", (e) => {
      void this.#handleMessage(e);
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
  /** Send a CredentialRequest and resolve to the delivered descriptors.
   *  Times out if no `credential_delivered` arrives within `timeoutMs`. */
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
    return await new Promise((resolve3, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(clientMsgId);
        reject(new Error("credential_request_timeout"));
      }, timeoutMs);
      this.#pendingRequests.set(clientMsgId, {
        resolve: resolve3,
        reject,
        timer,
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
          ...update.message ? { message: update.message } : {}
        })
      );
    } catch {
    }
  }
  /** Close the socket and stop reconnecting. */
  close() {
    this.#closed = true;
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
  async #buildQuery() {
    const creds = await this.opts.credentials();
    if (creds.mode === "secret") {
      return { agent_secret: creds.agentSecret };
    }
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
    if (!this.#ps) return;
    const noStateYet = this.#lastServerSeq === "0" && this.#knownCredentials.length === 0;
    if (noStateYet) return;
    this.#ps.send(
      JSON.stringify({
        type: "resume",
        client_msg_id: crypto.randomUUID(),
        last_server_seq: this.#lastServerSeq,
        known_credentials: this.#knownCredentials,
        capabilities: this.opts.capabilities
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
    try {
      await this.#dispatch(frame);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
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
          if (this.#ps && preResetKnown.length > 0) {
            this.#ps.send(
              JSON.stringify({
                type: "resume",
                client_msg_id: crypto.randomUUID(),
                last_server_seq: "0",
                known_credentials: preResetKnown,
                capabilities: this.opts.capabilities
              })
            );
          }
          return;
        }
        this.#sendResumeIfApplicable();
        return;
      }
      case "credential_delivered": {
        const isBootstrapCause = frame.cause === "bootstrap" || frame.cause === "re_bootstrap";
        if (!isBootstrapCause && await this.#handleIfRedacted(
          frame.credentials,
          frame.seq,
          `credential_delivered{cause:'${frame.cause}'}`
        )) {
          return;
        }
        await this.opts.onCredentialDelivered(frame);
        this.#trackKnownCredentials(frame.credentials);
        await this.#advanceSeq(frame.seq);
        if (isBootstrapCause) {
          this.#queueRefreshForBareIssued(frame.credentials);
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
        if (await this.#handleIfRedacted(
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
    }
  }
  /**
   * Handles a credential frame that has any redacted credential (no
   * `scoped_token`). See the redacted-replay contract in protocol.ts.
   *
   * Returns `true` if any credential was redacted (caller should return
   * early, skipping `onCredentialDelivered`/`onCredentialRotated`).
   * Returns `false` when all credentials carry a `scoped_token`.
   *
   * When redacted: advances seq, logs via `onError` (informational), and
   * queues a fire-and-forget `requestRefresh` for each bare credential.
   * `client_closed` rejections on teardown are swallowed silently.
   */
  async #handleIfRedacted(creds, seq, logLabel, supersededId) {
    const issuedCreds = creds.filter(
      (c) => {
        const effKind = c.kind ?? (c.provider === "github" ? "issued" : c.kind);
        return effKind === "issued";
      }
    );
    if (!issuedCreds.some((c) => !c.scoped_token)) return false;
    await this.#advanceSeq(seq);
    const redactedNotice = `agent-control: redacted ${logLabel} \u2014 queuing credential_request to obtain fresh secret`;
    if (this.opts.onInfo) {
      this.opts.onInfo(redactedNotice);
    } else {
      this.opts.onError?.(new Error(redactedNotice));
    }
    this.#queueRefreshForBareIssued(creds, supersededId);
    return true;
  }
  /**
   * Queue a fire-and-forget `credential_request` for each ISSUED (github)
   * credential that arrived WITHOUT a `scoped_token`. Shared by the
   * redacted-replay path (`#handleIfRedacted`) and the bootstrap/re_bootstrap
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
      void this.requestRefresh({
        reason: "expiry",
        provider: issued.provider,
        superseded_scoped_token_id: supersededId ?? issued.scoped_token_id ?? issued.credential_id
      }).catch((err) => {
        if (err instanceof Error && (err.message === "client_closed" || err.message === "client not started")) {
          return;
        }
        this.opts.onError?.(
          err instanceof Error ? err : new Error(String(err))
        );
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
function makeErrorSafeWebSocket(Base, headers) {
  function Wrapped(url, protocols) {
    const ws = headers ? (
      // biome-ignore lint/suspicious/noExplicitAny: bridging to ws (url, protocols, options) signature (see above).
      new Base(url, protocols, { headers })
    ) : (
      // biome-ignore lint/suspicious/noExplicitAny: bridging to ws (url, protocols) signature (see above).
      new Base(url, protocols)
    );
    if (ws && typeof ws.on === "function") {
      ws.on("error", () => {
      });
    }
    return ws;
  }
  Wrapped.prototype = Base.prototype;
  return Wrapped;
}
var INSTANCE_FINGERPRINT_HEADER = "X-Spellguard-Instance-Fingerprint";
var INSTANCE_FINGERPRINT_MAX_LEN = 255;
var ENV = {
  BOOTSTRAP_NONCE: "SPELLGUARD_BOOTSTRAP_NONCE",
  ENDPOINT: "SPELLGUARD_ENDPOINT",
  AGENT_ID: "SPELLGUARD_AGENT_ID",
  RAILWAY_SERVICE_ID: "RAILWAY_SERVICE_ID"
};
function shouldRunManagedBootstrap(env = process.env) {
  const v = env[ENV.BOOTSTRAP_NONCE];
  return typeof v === "string" && v.length > 0;
}
async function resolveInstanceFingerprint(opts = {}) {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m) => console.warn(m));
  const fetchInstanceId = opts.fetchInstanceId ?? defaultFetchInstanceId;
  try {
    const id = await fetchInstanceId();
    if (id && id.length > 0) return truncate(id, INSTANCE_FINGERPRINT_MAX_LEN);
  } catch {
  }
  const railwayId = env[ENV.RAILWAY_SERVICE_ID];
  if (typeof railwayId === "string" && railwayId.length > 0) {
    return truncate(railwayId, INSTANCE_FINGERPRINT_MAX_LEN);
  }
  const host = (opts.hostnameImpl ?? hostname)();
  const now = (opts.nowImpl ?? Date.now)();
  warn(
    "spellguard: instance fingerprint detection failed (no AWS IMDS, no RAILWAY_SERVICE_ID); using fallback. Server-side correlation will be best-effort."
  );
  return truncate(`unknown-${host}-${now}`, INSTANCE_FINGERPRINT_MAX_LEN);
}
function truncate(s, max) {
  return s.length > max ? s.slice(0, max) : s;
}
async function defaultFetchInstanceId() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(
      "http://169.254.169.254/latest/meta-data/instance-id",
      { signal: controller.signal }
    );
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function runManagedBootstrap(opts = {}) {
  const env = opts.env ?? process.env;
  const nonce = env[ENV.BOOTSTRAP_NONCE];
  const endpoint = env[ENV.ENDPOINT];
  const agentId = env[ENV.AGENT_ID];
  if (!nonce) {
    throw new Error(
      `${ENV.BOOTSTRAP_NONCE} is required for managed-provisioning bootstrap`
    );
  }
  if (!endpoint) {
    throw new Error(
      `${ENV.ENDPOINT} is required for managed-provisioning bootstrap`
    );
  }
  if (!agentId) {
    throw new Error(
      `${ENV.AGENT_ID} is required for managed-provisioning bootstrap`
    );
  }
  const instanceFingerprint = await resolveInstanceFingerprint(opts);
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1e3;
  return await new Promise((resolve3, reject) => {
    let settled = false;
    let client = null;
    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client?.close();
      } catch {
      }
      if (err) reject(err);
      else if (result) resolve3(result);
    };
    const timer = setTimeout(() => {
      settle(
        new Error(
          `spellguard: managed-bootstrap timed out after ${Math.floor(timeoutMs / 1e3)}s waiting for credential_delivered{cause:'bootstrap'}`
        )
      );
    }, timeoutMs);
    const credentials = () => ({
      mode: "managed-bootstrap",
      nonce
    });
    client = new AgentControlClient({
      apiBaseUrl: endpoint,
      agentId,
      credentials,
      upgradeHeaders: { [INSTANCE_FINGERPRINT_HEADER]: instanceFingerprint },
      onCredentialDelivered: (frame) => {
        if (frame.cause !== "bootstrap") {
          return;
        }
        if (!frame.agent_secret) {
          settle(
            new Error(
              "spellguard: bootstrap frame missing agent_secret \u2014 server bug or out-of-date server version"
            )
          );
          return;
        }
        const bootstrapFrame = frame;
        settle(null, {
          agentId,
          agentSecret: frame.agent_secret,
          spellguardBaseUrl: endpoint,
          instanceFingerprint,
          frame: bootstrapFrame
        });
      },
      onSeqAdvanced: () => {
      },
      onFatalClose: (code, reason) => {
        let label;
        switch (code) {
          case AGENT_CONTROL_CLOSE_CODES.BOOTSTRAP_ERROR:
            label = "bootstrap_error";
            break;
          case AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED:
            label = "auth_failed";
            break;
          case AGENT_CONTROL_CLOSE_CODES.AGENT_OWNERSHIP:
            label = "agent_ownership";
            break;
          default:
            label = `code_${code}`;
        }
        settle(
          new Error(
            `spellguard: managed-bootstrap channel closed (${label}${reason ? `: ${reason}` : ""})`
          )
        );
      },
      onError: (err) => {
        const msg = err.message ?? "";
        if (msg.includes("server:")) {
          settle(
            new Error(`spellguard: managed-bootstrap server error: ${msg}`)
          );
        }
      },
      ...opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}
    });
    client.start();
  });
}
var AGENT_GONE_HTTP_STATUSES = [401, 403, 404, 410];
function isAgentGoneStatus(httpStatus) {
  return httpStatus !== void 0 && AGENT_GONE_HTTP_STATUSES.includes(httpStatus);
}
var USER_AGENT = "spellguard-plugin/0.1.0";
function createManagementClient(opts) {
  const baseFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const retryDelay = opts.retryDelayMs ?? 1e3;
  const retryOn5xx = opts.retry ?? true;
  const retryingFetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    if (!retryOn5xx) return baseFetch(req);
    const first = await baseFetch(req.clone());
    if (first.status >= 500) {
      await new Promise((resolve3) => setTimeout(resolve3, retryDelay));
      return baseFetch(req);
    }
    return first;
  };
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
    baseUrl: `${opts.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`,
    fetch: retryingFetch
  });
  client.use(auth);
  return client;
}

// src/lib/config-store.ts
import {
  chmodSync as chmodSync2,
  closeSync as closeSync2,
  copyFileSync,
  existsSync,
  mkdirSync as mkdirSync2,
  openSync as openSync2,
  readFileSync,
  renameSync as renameSync2,
  rmSync as rmSync2,
  statSync,
  writeFileSync as writeFileSync2,
  writeSync as writeSync2
} from "node:fs";
import { homedir, platform as platform2 } from "node:os";
import { dirname as dirname3, join as join2 } from "node:path";

// src/lib/framework-slug.ts
var FRAMEWORK_SLUG = "claude-code";

// src/lib/gh-token-file.ts
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { platform } from "node:os";
import { dirname as dirname2, join } from "node:path";
function writeGhTokenFile(path, token) {
  if (!token) return;
  mkdirSync(dirname2(path), { recursive: true, mode: 448 });
  const tmpPath = `${path}.tmp`;
  if (platform() !== "win32") {
    const fd = openSync(tmpPath, "w", 384);
    try {
      writeSync(fd, token, 0, "utf-8");
    } finally {
      closeSync(fd);
    }
    chmodSync(tmpPath, 384);
  } else {
    writeFileSync(tmpPath, token, "utf-8");
  }
  renameSync(tmpPath, path);
}
function clearGhTokenFile(path) {
  try {
    rmSync(path, { force: true });
  } catch {
  }
}

// src/lib/config-store.ts
function spellguardRootDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join2(xdg, "spellguard") : join2(homedir(), ".config", "spellguard");
}
function defaultConfigDir() {
  return join2(spellguardRootDir(), FRAMEWORK_SLUG);
}
function defaultConfigPath() {
  return join2(defaultConfigDir(), "config.json");
}
function gitTokensPath(dir = defaultConfigDir()) {
  return join2(dir, "git-tokens");
}
function writeGitTokensFile(config, dir = defaultConfigDir()) {
  const path = gitTokensPath(dir);
  const lines = [];
  let wildcardToken;
  let usableCount = 0;
  let keyedTotal = 0;
  const keyed = config.githubCredentials;
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
  if (lines.length === 0) {
    if (existsSync(path)) rmSync2(path, { force: true });
    return;
  }
  mkdirSync2(dirname3(path), { recursive: true, mode: 448 });
  const content = `${lines.join("\n")}
`;
  const tmpPath = `${path}.tmp`;
  if (platform2() !== "win32") {
    const fd = openSync2(tmpPath, "w", 384);
    try {
      writeSync2(fd, content, 0, "utf-8");
    } finally {
      closeSync2(fd);
    }
  } else {
    writeFileSync2(tmpPath, content, "utf-8");
  }
  renameSync2(tmpPath, path);
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
  return null;
}
function readConfig(path = defaultConfigPath()) {
  if (!existsSync(path)) return { config: null, reason: "missing" };
  if (platform2() !== "win32") {
    try {
      const stat = statSync(path);
      const mode = stat.mode & 511;
      if (mode !== 384) return { config: null, reason: "wrong_permissions" };
    } catch {
      return { config: null, reason: "missing" };
    }
  }
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
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
    return { config: parsed };
  } catch {
    return { config: null, reason: "malformed", malformedField: "json" };
  }
}
function writeConfig(config, path = defaultConfigPath()) {
  mkdirSync2(dirname3(path), { recursive: true, mode: 448 });
  const content = JSON.stringify(config, null, 2);
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
      if (platform2() !== "win32") chmodSync2(`${path}.bak`, 384);
    } catch {
    }
  }
  const tmpPath = `${path}.tmp`;
  if (platform2() !== "win32") {
    const fd = openSync2(tmpPath, "w", 384);
    try {
      writeSync2(fd, content, 0, "utf-8");
    } finally {
      closeSync2(fd);
    }
  } else {
    writeFileSync2(tmpPath, content, "utf-8");
  }
  renameSync2(tmpPath, path);
  writeGitTokensFile(config, dirname3(path));
}
function markConfigRevoked(path = defaultConfigPath()) {
  const result = readConfig(path);
  if (result.config) {
    writeConfig({ ...result.config, revoked: true }, path);
  }
}

// src/lib/env-file-writer.ts
import {
  appendFileSync,
  chmodSync as chmodSync3,
  copyFileSync as copyFileSync2,
  existsSync as existsSync2,
  mkdirSync as mkdirSync3,
  writeFileSync as writeFileSync3
} from "node:fs";
import { dirname as dirname4, join as join3, resolve } from "node:path";
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
var HERE = dirname4(fileURLToPath(import.meta.url));
function bundledHelperPath() {
  return resolve(HERE, "..", "..", "bin", "spellguard-git-helper");
}
function ensureStableHelper(configDir) {
  const bundled = bundledHelperPath();
  try {
    const dest = join3(configDir, "bin", "spellguard-git-helper");
    mkdirSync3(dirname4(dest), { recursive: true });
    copyFileSync2(bundled, dest);
    chmodSync3(dest, 493);
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
    writeFileSync3(spec.envFilePath, `${lines.join("\n")}
`, "utf-8");
  }
}

// src/lib/gh-config-dir.ts
import {
  existsSync as existsSync3,
  mkdirSync as mkdirSync4,
  renameSync as renameSync3,
  rmSync as rmSync3,
  writeFileSync as writeFileSync4
} from "node:fs";
import { join as join4 } from "node:path";
function ghConfigDirPath(configDir, agentId) {
  return join4(configDir, "gh", agentId);
}
function writeGhSessionConfig(args) {
  const host = args.host ?? "github.com";
  mkdirSync4(args.dir, { recursive: true, mode: 448 });
  const configYml = join4(args.dir, "config.yml");
  if (!existsSync3(configYml)) {
    writeFileSync4(configYml, 'version: "1"\n', { mode: 384 });
  }
  const hosts = `${host}:
    oauth_token: ${args.token}
    git_protocol: https
`;
  const hostsTmp = join4(args.dir, "hosts.yml.tmp");
  writeFileSync4(hostsTmp, hosts, { mode: 384 });
  renameSync3(hostsTmp, join4(args.dir, "hosts.yml"));
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
function dropStaleDefaultKey(creds, installedRealKey, supersededId) {
  const def = creds.__default;
  const shouldDrop = Boolean(def) && installedRealKey && (supersededId === void 0 || supersededId === def?.scopedTokenId);
  if (!shouldDrop) return creds;
  return Object.fromEntries(
    Object.entries(creds).filter(([key]) => key !== "__default")
  );
}
function syncGhTokenFile(deps, token) {
  if (!deps.ghTokenPath) return;
  if (token) writeGhTokenFile(deps.ghTokenPath, token);
  else clearGhTokenFile(deps.ghTokenPath);
}
function handleCredentialUpdate(frame, deps) {
  const ghCreds = frame.credentials.filter(
    (c) => c.provider === "github" && Boolean(c.scoped_token)
  );
  if (ghCreds.length === 0) return;
  const cur = deps.readConfigImpl();
  if (!cur.config) return;
  const hadKeyedMap = cur.config.githubCredentials !== void 0 && Object.keys(cur.config.githubCredentials).length > 0;
  if (!hadKeyedMap && cur.config.revoked) return;
  const githubCredentials = {
    ...cur.config.githubCredentials ?? {}
  };
  let firstInstalled = null;
  for (const ghCred of ghCreds) {
    const key = githubEntryKey(ghCred.github_org_login);
    if (githubCredentials[key]?.revoked) continue;
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
  if (firstInstalled === null) return;
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
    revoked: false
  });
  if (deps.envFilePath) {
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
  syncGhTokenFile(deps, firstInstalled.entry.scopedToken);
}

// src/lib/apply-bundle.ts
var ONE_YEAR_MS = 1e3 * 60 * 60 * 24 * 365;
function require_(cond, message) {
  if (!cond) throw new Error(message);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function parseBundle(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`bundle is not valid JSON: ${err.message}`);
  }
  require_(
    parsed != null && typeof parsed === "object" && !Array.isArray(parsed),
    "bundle must be a JSON object"
  );
  const b = parsed;
  require_(isNonEmptyString(b.agent_id), "bundle.agent_id must be a string");
  require_(
    isNonEmptyString(b.agent_secret),
    "bundle.agent_secret must be a string"
  );
  require_(
    isNonEmptyString(b.spellguard_base_url),
    "bundle.spellguard_base_url must be a string"
  );
  require_(Array.isArray(b.credentials), "bundle.credentials must be an array");
  const credentials = b.credentials.map((c, i) => {
    require_(
      c != null && typeof c === "object",
      `bundle.credentials[${i}] must be an object`
    );
    const cr = c;
    require_(
      cr.provider === "github",
      `bundle.credentials[${i}].provider must be 'github'`
    );
    require_(
      isNonEmptyString(cr.credential_id),
      `bundle.credentials[${i}].credential_id must be a string`
    );
    require_(
      isNonEmptyString(cr.scoped_token),
      `bundle.credentials[${i}].scoped_token must be a string`
    );
    require_(
      isNonEmptyString(cr.expires_at),
      `bundle.credentials[${i}].expires_at must be a string`
    );
    const scope = cr.scope_summary;
    require_(
      scope != null && typeof scope === "object" && Array.isArray(scope.repos) && scope.repos.every((r) => typeof r === "string"),
      `bundle.credentials[${i}].scope_summary.repos must be a string[]`
    );
    require_(
      isNonEmptyString(cr.git_author_name),
      `bundle.credentials[${i}].git_author_name must be a string`
    );
    require_(
      isNonEmptyString(cr.git_author_email),
      `bundle.credentials[${i}].git_author_email must be a string`
    );
    return cr;
  });
  return {
    agent_id: b.agent_id,
    agent_secret: b.agent_secret,
    spellguard_base_url: b.spellguard_base_url,
    credentials
  };
}
function toDescriptor(agentId, c) {
  return {
    provider: "github",
    kind: "issued",
    credential_id: c.credential_id,
    scoped_token_id: c.scoped_token_id ?? c.credential_id,
    scoped_token: c.scoped_token,
    agent_id: agentId,
    status: "valid",
    expires_at: c.expires_at,
    scope_summary: c.scope_summary,
    ...c.github_org_login ? { github_org_login: c.github_org_login } : {},
    ...typeof c.installation_id === "number" ? { installation_id: c.installation_id } : {},
    provider_data: {
      github_user_id: 0,
      github_login: c.github_org_login ?? "",
      github_user_email: null,
      git_author_name: c.git_author_name,
      git_author_email: c.git_author_email
    }
  };
}
function applyCredentialBundle(bundle) {
  const configPath = defaultConfigPath();
  const configDir = defaultConfigDir();
  writeConfig(
    {
      scopedToken: "",
      scopedTokenId: "",
      agentId: bundle.agent_id,
      agentSecret: bundle.agent_secret,
      expiresAt: new Date(Date.now() + ONE_YEAR_MS).toISOString(),
      scopeSummary: { repos: [] },
      spellguardBaseUrl: bundle.spellguard_base_url,
      knownCredentials: bundle.credentials.map((c) => ({
        provider: "github",
        scoped_token_id: c.scoped_token_id ?? c.credential_id
      })),
      revoked: false
    },
    configPath
  );
  const frame = {
    type: "credential_delivered",
    cause: "bootstrap",
    seq: "0",
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    credentials: bundle.credentials.map(
      (c) => toDescriptor(bundle.agent_id, c)
    )
  };
  handleCredentialUpdate(frame, {
    // Same surface the daemon writes when CLAUDE_ENV_FILE is present; skipped
    // (per the handler's own guard) when the CLI runs without it.
    envFilePath: process.env.CLAUDE_ENV_FILE ?? "",
    writeConfigImpl: (cfg) => writeConfig(cfg, configPath),
    markConfigRevokedImpl: () => markConfigRevoked(configPath),
    readConfigImpl: () => readConfig(configPath),
    ghConfigDir: ghConfigDirPath(configDir, bundle.agent_id),
    helperPath: ensureStableHelper(configDir)
  });
  return {
    agentId: bundle.agent_id,
    credentialIds: bundle.credentials.map((c) => c.credential_id)
  };
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
async function runApplyBundle() {
  try {
    const raw = await readStdin();
    const bundle = parseBundle(raw);
    const result = applyCredentialBundle(bundle);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        agentId: result.agentId,
        credentialIds: result.credentialIds
      })}
`
    );
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: err?.message ?? String(err)
      })}
`
    );
    process.exit(1);
  }
}

// src/lib/setup-cli-args.ts
var UsageError = class extends Error {
};
var CHOICE_MAP = {
  print: "print_identity",
  additional: "provision_additional",
  reauthorize: "reauthorize"
};
var VALUE_FLAGS = ["--base-url", "--agent-id", "--choice"];
var SETUP_USAGE = [
  "Usage: skill-spellguard-setup [options]",
  "",
  "Options:",
  "  --base-url <url>   Target a non-default Spellguard broker",
  "  --agent-id <uuid>  Re-bind a specific agent UUID (lost-config recovery)",
  "  --choice <print|additional|reauthorize>",
  "                     Non-interactive answer to the existing-credential menu",
  "  -h, --help         Show this help and exit",
  "",
  "To disconnect this machine entirely, use /spellguard-reset."
].join("\n");
function flagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx !== -1) {
    const v = argv[idx + 1];
    if (v === void 0 || v.startsWith("--")) {
      throw new UsageError(`${flag} requires a value.`);
    }
    return v;
  }
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : void 0;
}
function parseSetupArgv(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { action: "help" };
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) continue;
    const bare = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (!VALUE_FLAGS.includes(bare)) {
      throw new UsageError(`Unknown option "${a}".`);
    }
  }
  const baseUrl = flagValue(argv, "--base-url");
  const agentId = flagValue(argv, "--agent-id");
  if (agentId !== void 0 && !/^[0-9a-f-]{36}$/i.test(agentId)) {
    throw new UsageError(`--agent-id must be a UUID (got "${agentId}").`);
  }
  const rawChoice = flagValue(argv, "--choice");
  let choice;
  if (rawChoice !== void 0) {
    choice = CHOICE_MAP[rawChoice];
    if (!choice) {
      throw new UsageError(
        `Invalid --choice "${rawChoice}". Valid values: print, additional, reauthorize.`
      );
    }
  }
  return {
    action: "run",
    ...baseUrl !== void 0 ? { baseUrl } : {},
    ...agentId !== void 0 ? { agentId } : {},
    ...choice !== void 0 ? { choice } : {}
  };
}

// src/skills/spellguard-setup.ts
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

// src/lib/daemon-spawn.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync4, readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname5, join as join5, sep } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function daemonScriptPath() {
  const here = dirname5(fileURLToPath2(import.meta.url));
  const devPath = join5(
    here,
    "..",
    "..",
    "bin",
    "spellguard-credential-daemon.ts"
  );
  const builtPath = join5(here, "spellguard-credential-daemon.mjs");
  const runningFromDist = here.endsWith(`${sep}dist${sep}bin`) || here.endsWith("/dist/bin");
  if (runningFromDist && existsSync4(builtPath)) return builtPath;
  if (existsSync4(devPath)) return devPath;
  return builtPath;
}
function readDaemonPid(pidPath) {
  if (!existsSync4(pidPath)) return null;
  try {
    const raw = readFileSync2(pidPath, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
function isDaemonAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function ensureCredentialDaemonRunning(args) {
  const { config, cwd } = args;
  if (!config.agentSecret || !config.agentId) {
    return { daemon: "skipped", reason: "missing_credentials" };
  }
  const configDir = args.configDir ?? defaultConfigDir();
  const pidDir = join5(configDir, "agents");
  const pidPath = join5(pidDir, `${config.agentId}.pid`);
  const existingPid = readDaemonPid(pidPath);
  if (existingPid !== null && isDaemonAlive(existingPid)) {
    return { daemon: "already-running", pid: existingPid };
  }
  const scriptPath = daemonScriptPath();
  const spawnFn = args.spawnDaemon ?? defaultSpawnDaemon;
  spawnFn(process.execPath, [scriptPath, config.agentId, "--cwd", cwd], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      // Forward CLAUDE_ENV_FILE only when the caller has one (hook context).
      // The daemon logs + skips env-file updates when it is absent.
      ...args.envFilePath ? { CLAUDE_ENV_FILE: args.envFilePath } : {}
    }
  });
  return { daemon: "spawned" };
}
function defaultSpawnDaemon(execPath, args, opts) {
  const child = spawn(execPath, args, opts);
  child.unref();
}

// src/lib/plugin-sync.ts
var FRAMEWORK = "claude_code";

// src/lib/probe-identity.ts
async function probeAgentIdentity(opts) {
  try {
    const api = createManagementClient({
      baseUrl: opts.baseUrl,
      agentId: opts.agentId,
      agentSecret: opts.agentSecret,
      fetchImpl: opts.fetchImpl
    });
    const { error, response } = await api.GET("/credentials/github/status", {
      params: { query: { scoped_token_id: opts.scopedTokenId ?? "" } }
    });
    if (!error) return "ok";
    const status = response?.status;
    if (opts.scopedTokenId) {
      return isAgentGoneStatus(status) ? "gone" : "transient";
    }
    return status === 401 ? "gone" : "transient";
  } catch {
    return "transient";
  }
}

// src/lib/sqlite-self-install.ts
import { spawn as spawn2 } from "node:child_process";
import { accessSync, constants as fsConstants, mkdirSync as mkdirSync5 } from "node:fs";
import { dirname as dirname6, resolve as resolve2 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/lib/sqlite-backend.ts
import { createRequire } from "node:module";
var localRequire = typeof __require === "function" ? __require : createRequire(import.meta.url);
function suppressSqliteExperimentalWarning() {
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const optsOrType = rest[0];
    const type = typeof optsOrType === "object" && optsOrType !== null ? optsOrType.type : optsOrType;
    const name = typeof warning === "object" ? warning?.name : void 0;
    const message = typeof warning === "string" ? warning : warning?.message ?? "";
    const isSqliteExperimental = type === "ExperimentalWarning" || name === "ExperimentalWarning" || typeof message === "string" && message.includes("SQLite is an experimental");
    if (isSqliteExperimental) return;
    return original.call(process, warning, ...rest);
  };
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
    const backend = adaptNodeSqlite(mod.DatabaseSync);
    const probe = backend.open(":memory:");
    probe.exec("CREATE TABLE __probe (x); DROP TABLE __probe;");
    probe.close();
    return backend;
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
function hasUsableSqliteBackend() {
  return loadSqliteBackend() !== null;
}

// src/lib/sqlite-self-install.ts
var SELF_INSTALL_PACKAGES = [
  "better-sqlite3@^12",
  "bindings@^1",
  "file-uri-to-path@^1"
];
function resolvePluginRoot(overrideDir) {
  if (overrideDir) return overrideDir;
  const here = dirname6(fileURLToPath3(import.meta.url));
  return resolve2(here, "..", "..");
}
function isWritable(dir) {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
async function ensureSqliteBackend(opts = {}) {
  const hasBackend = opts.hasBackend ?? hasUsableSqliteBackend;
  if (hasBackend()) return { status: "already" };
  const pluginRoot = resolvePluginRoot(opts.pluginRoot);
  try {
    mkdirSync5(resolve2(pluginRoot, "node_modules"), { recursive: true });
  } catch (err) {
    return {
      status: "skipped",
      installDir: pluginRoot,
      reason: `plugin directory is not writable (${err.message})`
    };
  }
  if (!isWritable(pluginRoot)) {
    return {
      status: "skipped",
      installDir: pluginRoot,
      reason: "plugin directory is not writable"
    };
  }
  const runInstall = opts.runInstall ?? defaultNpmInstall;
  let installOutcome;
  try {
    installOutcome = await runInstall({
      cwd: pluginRoot,
      packages: SELF_INSTALL_PACKAGES
    });
  } catch (err) {
    return {
      status: "failed",
      installDir: pluginRoot,
      reason: `npm install could not run (${err.message}); is npm on PATH?`
    };
  }
  if (installOutcome.code !== 0) {
    return {
      status: "failed",
      installDir: pluginRoot,
      reason: `npm install exited ${installOutcome.code}${installOutcome.stderr ? `: ${installOutcome.stderr.trim()}` : ""}`
    };
  }
  const hasAfter = opts.hasBackendAfter ?? hasUsableSqliteBackend;
  if (!hasAfter()) {
    return {
      status: "failed",
      installDir: pluginRoot,
      reason: "better-sqlite3 installed but did not load (no prebuilt binary for this platform/arch?)"
    };
  }
  return { status: "installed", installDir: pluginRoot };
}
function defaultNpmInstall(args) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn2(
      "npm",
      [
        "install",
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        ...args.packages
      ],
      {
        cwd: args.cwd,
        // Inherit stdout so prebuild-install progress is visible; capture
        // stderr so we can surface a concise reason on failure.
        stdio: ["ignore", "inherit", "pipe"],
        env: process.env
      }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectP);
    child.on("close", (code) => resolveP({ code: code ?? 1, stderr }));
  });
}

// src/lib/stop-daemons.ts
import { readFileSync as readFileSync3, readdirSync, unlinkSync } from "node:fs";
import { join as join6 } from "node:path";
function stopLocalDaemons(opts) {
  const dir = join6(opts?.configDir ?? defaultConfigDir(), "agents");
  const kill = opts?.killImpl ?? process.kill.bind(process);
  let entries;
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".pid"));
  } catch {
    return [];
  }
  const stopped = [];
  for (const f of entries) {
    const p = join6(dir, f);
    let pid;
    try {
      pid = Number.parseInt(readFileSync3(p, "utf8").trim(), 10);
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      kill(pid, "SIGTERM");
      stopped.push(pid);
    } catch {
    }
    try {
      unlinkSync(p);
    } catch {
    }
  }
  return stopped;
}

// src/skills/spellguard-setup.ts
var DEFAULT_SPELLGUARD_BASE = (() => { const v = process.env.SPELLGUARD_BASE_URL; if (!v) throw new Error('SPELLGUARD_BASE_URL is not set. Set it to your Spellguard console URL, e.g. export SPELLGUARD_BASE_URL=https://your-spellguard-console.example.com'); return v; })();
async function pollChannelToken(apiBaseUrl, nonce, opts = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? 2e3;
  const maxAttempts = opts.maxAttempts ?? 300;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = apiBaseUrl.replace(/\/$/, "");
  const url = `${base}/v1/bootstrap/channel-token/${encodeURIComponent(nonce)}`;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const res = await fetchImpl(url).catch(() => null);
    if (res?.ok) {
      const body = await res.json();
      if (body.channelToken && body.userId && body.orgId && body.agentName) {
        return {
          channelToken: body.channelToken,
          userId: body.userId,
          orgId: body.orgId,
          agentName: body.agentName,
          reason: body.reason,
          agentId: body.agentId
        };
      }
    } else if (res && res.status !== 404) {
      let errText = "";
      try {
        errText = await res.text();
      } catch {
      }
      throw new Error(
        `channel-token poll failed: ${res.status}${errText ? ` ${errText}` : ""}`
      );
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  throw new Error(
    "Channel token not minted within 10 minutes \u2014 user may not have visited /setup in their browser or submitted the agent name form."
  );
}
function generateNonce() {
  return randomBytes(32).toString("base64url");
}
var INITIATING_FRAMEWORK = FRAMEWORK;
async function registerInitiatingFramework(baseUrl, nonce, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/$/, "");
  try {
    await fetchImpl(`${base}/v1/bootstrap/register-framework`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce, framework: INITIATING_FRAMEWORK })
    });
  } catch {
  }
}
function dashboardUrl(baseUrl, nonce) {
  return `${baseUrl.replace(/\/$/, "")}/setup?bootstrap=${encodeURIComponent(nonce)}`;
}
async function promptExistingConfigChoice(opts) {
  const question = [
    "Spellguard: an existing credential is present. Choose an action:",
    "  1) Print current identity and exit",
    "  2) Provision an additional agent (the server keeps the existing agent; the credential stored on THIS machine is replaced)",
    "  3) Re-authorize (re-binds the same agent identity; only the secret rotates)",
    "Enter 1, 2, or 3: "
  ].join("\n");
  if (!opts.promptFn && !process.stdin.isTTY) {
    renderMessage({
      level: "warn",
      message: "Spellguard: an existing credential is present and no interactive terminal is available. Printing the current identity. To act on it non-interactively, re-run with --choice reauthorize | additional | print, or use /spellguard-reset to disconnect this machine."
    });
    return "print_identity";
  }
  const ask = opts.promptFn ? opts.promptFn : (q) => {
    const rl = createInterface({
      input: opts.input ?? process.stdin,
      output: opts.output ?? process.stdout
    });
    return new Promise((resolve3) => {
      rl.question(q, (answer) => {
        rl.close();
        resolve3(answer);
      });
    });
  };
  for (let i = 0; i < 3; i++) {
    const raw = (await ask(question)).trim();
    if (raw === "1") return "print_identity";
    if (raw === "2") return "provision_additional";
    if (raw === "3") return "reauthorize";
    renderMessage({
      level: "warn",
      message: `Spellguard: unrecognized choice "${raw}". Enter 1, 2, or 3.`
    });
  }
  renderMessage({
    level: "warn",
    message: 'Spellguard: no valid choice after 3 attempts. Defaulting to "print identity and exit".'
  });
  return "print_identity";
}
function extractBootstrapIdentity(frame) {
  const rawCreds = frame.credentials;
  if (!Array.isArray(rawCreds)) {
    return {
      ok: false,
      reason: "malformed_credentials_array",
      message: "Spellguard: bootstrap frame was malformed (missing credentials array). Re-run /spellguard-setup."
    };
  }
  if (!frame.agent_secret) {
    return {
      ok: false,
      reason: "missing_agent_secret",
      message: "Spellguard: server bootstrap response missing agent_secret \u2014 out-of-date server version. Please upgrade the server and re-run /spellguard-setup."
    };
  }
  const ghMaybe = rawCreds.find(
    (c) => typeof c === "object" && c !== null && c.provider === "github"
  );
  const pd = ghMaybe?.provider_data;
  const ghWellFormed = ghMaybe?.scoped_token && pd && typeof pd.git_author_name === "string" && pd.git_author_name.length > 0 && typeof pd.git_author_email === "string" && pd.git_author_email.length > 0;
  return {
    ok: true,
    agentSecret: frame.agent_secret,
    ...ghWellFormed ? { ghCred: ghMaybe } : {}
  };
}
async function runSpellguardSetup(args = {}) {
  const baseUrl = args.baseUrl ?? DEFAULT_SPELLGUARD_BASE;
  const existing = readConfig();
  let reuseAgentId;
  let probeSaysGone = false;
  if (existing.config && !existing.config.revoked) {
    const probe = await probeAgentIdentity({
      baseUrl: existing.config.spellguardBaseUrl ?? baseUrl,
      agentId: existing.config.agentId,
      agentSecret: existing.config.agentSecret,
      scopedTokenId: existing.config.scopedTokenId,
      fetchImpl: args.fetchImpl
    });
    if (probe === "gone") {
      markConfigRevoked();
      renderMessage({
        level: "warn",
        message: "Spellguard: the stored agent is no longer recognized by the server (it was likely deleted or revoked in the dashboard). Starting fresh setup."
      });
      probeSaysGone = true;
    }
  }
  if (existing.config && !existing.config.revoked && !probeSaysGone) {
    const choice = args.existingConfigChoice ? await args.existingConfigChoice() : await promptExistingConfigChoice({});
    if (choice === "print_identity") {
      const lines = [
        "Spellguard: current identity:",
        `  agent=${existing.config.agentId}`,
        `  config_dir=${defaultConfigDir()}`
      ];
      if (existing.config.scopedTokenId) {
        lines.push(`  scoped_token_id=${existing.config.scopedTokenId}`);
      }
      if (existing.config.expiresAt) {
        lines.push(`  expires_at=${existing.config.expiresAt}`);
      }
      if (existing.config.scopeSummary) {
        lines.push(`  repos=${existing.config.scopeSummary.repos.join(", ")}`);
      } else {
        lines.push(
          "  github=not connected (complete the dashboard GitHub-App install to grant repo access)"
        );
      }
      lines.push(
        "No changes made. Re-run /spellguard-setup to choose a different action."
      );
      renderMessage({ level: "info", message: lines.join("\n") });
      return { ok: true, reason: "print_identity" };
    }
    if (choice === "provision_additional") {
      renderMessage({
        level: "info",
        message: "Spellguard: provisioning an additional agent \u2014 choose a unique agent name in the browser form. Note: the local credential on this machine will be replaced by the new one at the end of the flow."
      });
    } else {
      reuseAgentId = existing.config.agentId;
      renderMessage({
        level: "info",
        message: `Spellguard: re-authorizing \u2014 the same agent identity (agent=${existing.config.agentId}) is re-used and only the secret rotates (the server defers rotation until after issuance, so a mid-flow failure does not strand the old secret).`
      });
    }
  }
  if (existing.config?.revoked) {
    const cause = existing.config.revokedMessage ? `Spellguard: ${existing.config.revokedMessage}` : "Spellguard: this machine's Spellguard credential was revoked.";
    renderMessage({
      level: "warn",
      message: `${cause}

Re-running setup to RECONNECT this machine. In the browser, choose "Select an existing agent" to re-attach to your existing agent \u2014 it keeps the agent's history and restores its GitHub connection automatically. Only choose "Create a new agent" if you intend to provision a brand-new, separate agent.`
    });
  }
  let agentId = args.agentIdOverride ?? reuseAgentId ?? crypto.randomUUID();
  const nonce = generateNonce();
  await registerInitiatingFramework(baseUrl, nonce, {
    ...args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}
  });
  const url = dashboardUrl(baseUrl, nonce);
  renderMessage({
    level: "info",
    message: `Spellguard: open this URL in your browser to complete setup:
  ${url}

Waiting up to 10 minutes for browser approval and agent name\u2026`
  });
  const start = Date.now();
  const intervalMs = args.intervalMs ?? 3e4;
  const interval = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - start) / 1e3);
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    renderMessage({
      level: "info",
      message: `Spellguard: still waiting for browser approval (${m}m ${s}s elapsed of 10m).`
    });
    args.onProgress?.(elapsedSec);
  }, intervalMs);
  let channelToken;
  let orgId;
  let agentName;
  let statementOfReason;
  let isReattach = false;
  try {
    const polled = await pollChannelToken(baseUrl, nonce, {
      fetchImpl: args.fetchImpl,
      pollIntervalMs: args.pollIntervalMs,
      maxAttempts: args.pollMaxAttempts
    });
    channelToken = polled.channelToken;
    orgId = polled.orgId;
    agentName = polled.agentName;
    statementOfReason = polled.reason;
    if (polled.agentId) {
      agentId = polled.agentId;
      isReattach = true;
    }
  } catch (e) {
    clearInterval(interval);
    renderMessage({
      level: "error",
      message: `Spellguard: bootstrap timed out waiting for browser approval (${e.message}). Re-run /spellguard-setup to try again.`
    });
    return { ok: false, reason: e.message };
  }
  const result = await awaitBootstrapViaClient({
    apiBaseUrl: baseUrl,
    agentId,
    nonce,
    channelToken,
    orgId,
    agentName,
    statementOfReason,
    WebSocketImpl: args.WebSocketImpl,
    expectReBootstrap: isReattach
  });
  clearInterval(interval);
  if (!result.ok) {
    renderMessage({ level: "error", message: result.message });
    return { ok: false, reason: result.reason };
  }
  const { frame } = result;
  const extracted = extractBootstrapIdentity(frame);
  if (!extracted.ok) {
    renderMessage({ level: "error", message: extracted.message });
    return { ok: false, reason: extracted.reason };
  }
  const { agentSecret, ghCred } = extracted;
  const resolvedAgentId = frame.agent_id ?? agentId;
  const writtenConfig = {
    agentId: resolvedAgentId,
    agentSecret,
    agentName: frame.agent_name,
    spellguardBaseUrl: baseUrl,
    revoked: false,
    // Persist the bootstrap-frame seq + known_credentials projection
    // so the daemon's first connect can send a real Resume frame. Without
    // this, the daemon sends Resume{0, []}, the server's divergence check
    // fires on every cold start, and any frame pushed between bootstrap
    // and daemon attach is lost without these fields.
    lastServerSeq: frame.seq,
    knownCredentials: ghCred ? [
      {
        provider: ghCred.provider,
        scoped_token_id: ghCred.scoped_token_id ?? ghCred.credential_id
      }
    ] : [],
    // Legacy-server fallthrough: bundle the GitHub fields when the frame
    // happens to carry them.
    ...ghCred ? {
      scopedToken: ghCred.scoped_token,
      scopedTokenId: ghCred.scoped_token_id ?? ghCred.credential_id,
      expiresAt: ghCred.expires_at,
      scopeSummary: ghCred.scope_summary,
      gitAuthorName: ghCred.provider_data.git_author_name,
      gitAuthorEmail: ghCred.provider_data.git_author_email
    } : {}
  };
  try {
    (args.stopDaemons ?? stopLocalDaemons)({
      configDir: args.daemonConfigDir
    });
  } catch {
  }
  writeConfig(writtenConfig);
  const daemonResult = ensureCredentialDaemonRunning({
    config: writtenConfig,
    cwd: process.cwd(),
    envFilePath: process.env.CLAUDE_ENV_FILE,
    spawnDaemon: args.spawnDaemon,
    configDir: args.daemonConfigDir
  });
  await ensureAttributionBackend();
  if (ghCred) {
    const lines = [`Spellguard: agent provisioned (agent=${agentId}).`];
    const authorName = ghCred.provider_data.git_author_name;
    const authorEmail = ghCred.provider_data.git_author_email;
    if (authorName && authorEmail) {
      lines.push(
        `  Commits will be authored as: ${authorName} <${authorEmail}>`
      );
    }
    lines.push(
      "  Restart your Claude Code session for credentials to take effect."
    );
    renderMessage({ level: "info", message: lines.join("\n") });
    return { ok: true, daemon: daemonResult, githubCredential: "bundled" };
  }
  const daemonLine = daemonResult.daemon === "spawned" ? "  The credential daemon is now running and listening for it." : daemonResult.daemon === "already-running" ? `  The credential daemon is already running (pid ${daemonResult.pid}) and listening for it.` : `  WARNING: the credential daemon could not be started (${daemonResult.reason}); restart your session so the SessionStart hook can start it.`;
  renderMessage({
    level: "info",
    message: [
      `Spellguard: agent provisioned (agent=${agentId}).`,
      "  Next: open the dashboard and connect GitHub on this agent to grant",
      "  repo access \u2014 the GitHub credential lands in your local config the",
      "  moment that completes.",
      daemonLine
    ].join("\n")
  });
  const waitMs = args.credentialWaitMs ?? DEFAULT_CREDENTIAL_WAIT_MS;
  let delivered = null;
  if (daemonResult.daemon !== "skipped" && waitMs > 0) {
    renderMessage({
      level: "info",
      message: `Spellguard: waiting up to ${Math.round(waitMs / 6e4)} minute(s) for the GitHub credential (Ctrl-C is safe \u2014 the daemon keeps listening)\u2026`
    });
    delivered = await waitForGithubCredential(
      waitMs,
      args.credentialPollIntervalMs ?? 2e3
    );
  }
  if (delivered?.scopeSummary) {
    const author = delivered.gitAuthorName && delivered.gitAuthorEmail ? ` Commits will be authored as: ${delivered.gitAuthorName} <${delivered.gitAuthorEmail}>.` : "";
    renderMessage({
      level: "info",
      message: `Spellguard: GitHub credential received \u2014 repos=[${delivered.scopeSummary.repos.join(", ")}].${author}
  Git-credential protection for this session finishes wiring at the next session start (restart or /clear).`
    });
    return { ok: true, daemon: daemonResult, githubCredential: "delivered" };
  }
  renderMessage({
    level: "info",
    message: [
      "Spellguard: GitHub credential not delivered yet \u2014 that is fine. The",
      "  daemon keeps listening and writes it to your local config the moment",
      "  the dashboard GitHub-App install completes. Git-credential protection",
      "  for this session finishes wiring at the next session start (restart",
      "  or /clear); re-run /spellguard-setup any time to check status."
    ].join("\n")
  });
  return { ok: true, daemon: daemonResult, githubCredential: "pending" };
}
var DEFAULT_CREDENTIAL_WAIT_MS = 5 * 6e4;
async function waitForGithubCredential(timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let lastProgressAt = started;
  const delay = (ms) => new Promise((resolve3) => setTimeout(resolve3, ms));
  while (Date.now() < deadline) {
    const result = readConfig();
    if (result.config?.scopedToken) return result.config;
    if (Date.now() - lastProgressAt >= 3e4) {
      lastProgressAt = Date.now();
      const elapsedSec = Math.floor((Date.now() - started) / 1e3);
      renderMessage({
        level: "info",
        message: `Spellguard: still waiting for the GitHub credential (${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s elapsed) \u2014 complete the dashboard "Connect GitHub" step.`
      });
    }
    await delay(pollIntervalMs);
  }
  return null;
}
async function ensureAttributionBackend(opts) {
  const ensure = opts?.ensure ?? ensureSqliteBackend;
  let result;
  try {
    result = await ensure();
  } catch (err) {
    renderMessage({
      level: "warn",
      message: `Spellguard: could not verify the code-attribution database backend (${err.message}). Fine-grained commit attribution will be degraded; it self-heals on Node 24+ or after a local clone + \`pnpm install\`.`
    });
    return;
  }
  if (result.status === "already") {
    return;
  }
  if (result.status === "installed") {
    renderMessage({
      level: "info",
      message: "Spellguard: installed the code-attribution database backend (better-sqlite3, prebuilt binary). Per-line commit attribution is enabled."
    });
    return;
  }
  renderMessage({
    level: "warn",
    message: `Spellguard: could not install the code-attribution database backend (${result.reason ?? "unknown reason"}). Fine-grained commit attribution will be degraded. To enable it: upgrade to Node 24+ (built-in SQLite), or clone the plugin repo and run \`pnpm install\` so the native backend is present.`
  });
}
async function awaitBootstrapViaClient(opts) {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1e3;
  return new Promise((resolve3) => {
    let settled = false;
    let client = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client?.close();
      } catch {
      }
      resolve3(result);
    };
    const timer = setTimeout(() => {
      settle({
        ok: false,
        reason: "bootstrap_timeout",
        message: "Spellguard: bootstrap timed out or channel unavailable (bootstrap_timeout). Re-run /spellguard-setup to try again."
      });
    }, timeoutMs);
    client = new AgentControlClient({
      apiBaseUrl: opts.apiBaseUrl,
      agentId: opts.agentId,
      credentials: () => ({
        mode: "nonce",
        nonce: opts.nonce,
        channelToken: opts.channelToken,
        orgId: opts.orgId,
        ...opts.agentName ? { agentName: opts.agentName } : {},
        ...opts.statementOfReason ? { statementOfReason: opts.statementOfReason } : {},
        // Record the correct agents.framework at creation (REQ-FI) instead of
        // the server's hardcoded default; plugin-sync reconciles to the same
        // canonical value on startup.
        framework: FRAMEWORK,
        // C10: on a select-existing reattach the server auto-delivers
        // re_bootstrap — do not send (and get rejected on) a bootstrap_request.
        ...opts.expectReBootstrap ? { expectReBootstrap: true } : {}
      }),
      onCredentialDelivered: (frame) => {
        if (frame.cause !== "bootstrap" && frame.cause !== "re_bootstrap") {
          return;
        }
        settle({
          ok: true,
          frame
        });
      },
      onSeqAdvanced: (_seq) => {
      },
      onFatalClose: (code, reason) => {
        let message;
        switch (code) {
          case AGENT_CONTROL_CLOSE_CODES.BOOTSTRAP_ERROR:
            message = `Spellguard bootstrap failed: ${reason || "unknown error"}. Re-run /spellguard-setup to try again.`;
            break;
          case AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED:
            message = `Spellguard: authentication failed (${reason || "auth_failed"}); the nonce may already have been consumed by another session. Re-run /spellguard-setup.`;
            break;
          case AGENT_CONTROL_CLOSE_CODES.AGENT_OWNERSHIP:
            message = `Spellguard: agent ownership check failed (${reason || "agent_ownership"}). Confirm you're signed in to the correct organization and re-run /spellguard-setup.`;
            break;
          default:
            message = `Spellguard: bootstrap channel closed unexpectedly (code=${code}${reason ? `, reason=${reason}` : ""}). Re-run /spellguard-setup to try again.`;
        }
        settle({
          ok: false,
          reason: reason || String(code),
          message
        });
      },
      onError: (err) => {
        const msg = err.message ?? "";
        if (msg.includes("server:")) {
          settle({
            ok: false,
            reason: msg,
            message: buildServerErrorMessage(msg)
          });
          return;
        }
        renderMessage({
          level: "warn",
          message: `Spellguard: bootstrap channel error: ${msg}`
        });
      },
      ...opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}
    });
    client.start();
  });
}
function buildServerErrorMessage(errMsg) {
  const codeMatch = /server:\s*([^:]+):/.exec(errMsg);
  const code = codeMatch?.[1]?.trim() ?? "";
  if (code === "not_in_org") {
    return "Spellguard: you are not a member of any Spellguard organization. Ask your admin to invite you, then re-run /spellguard-setup.";
  }
  if (code === "nonce_expired") {
    return "Spellguard: bootstrap timed out (nonce expired). Re-run /spellguard-setup.";
  }
  if (code === "github_consent_declined") {
    return "Spellguard: GitHub authorization was declined. Re-run /spellguard-setup to retry.";
  }
  if (code === "sso_failure") {
    return "Spellguard: SSO failed mid-setup. Re-run /spellguard-setup.";
  }
  if (code === "session_mismatch") {
    return "Spellguard: the browser session that completed setup does not match the one that started it. Sign in to the Spellguard dashboard with the same account, then re-run /spellguard-setup.";
  }
  if (code === "membership_lost") {
    return "Spellguard: your organization membership was revoked during setup. Contact your organization admin, then re-run /spellguard-setup.";
  }
  if (code === "github_exchange_failed") {
    return "Spellguard: GitHub rejected the authorization code (likely transient). Re-run /spellguard-setup and complete the GitHub consent screen again.";
  }
  if (code === "github_identity_failed") {
    return "Spellguard: could not read your GitHub identity (GitHub /user call failed). Re-run /spellguard-setup; if this keeps happening, contact support.";
  }
  if (code === "validation_error") {
    return "Spellguard: the setup link was malformed or expired. Re-run /spellguard-setup to get a fresh link.";
  }
  return `Spellguard setup failed: ${errMsg}`;
}

// bin/run-spellguard-setup.ts
async function main() {
  if (process.argv.slice(2).includes("--apply-bundle")) {
    await runApplyBundle();
    return;
  }
  if (shouldRunManagedBootstrap(process.env)) {
    await runManagedFlow();
    return;
  }
  let parsed;
  try {
    parsed = parseSetupArgv(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}

${SETUP_USAGE}
`);
      process.exit(2);
    }
    throw err;
  }
  if (parsed.action === "help") {
    process.stdout.write(`${SETUP_USAGE}
`);
    return;
  }
  try {
    const result = await runSpellguardSetup({
      ...parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {},
      ...parsed.agentId ? { agentIdOverride: parsed.agentId } : {},
      ...parsed.choice ? { existingConfigChoice: async () => parsed.choice } : {}
    });
    process.stdout.write(`${JSON.stringify(result ?? {})}
`);
  } catch (err) {
    process.stderr.write(
      `spellguard-setup failed: ${err?.message ?? err}
`
    );
    process.exit(1);
  }
}
async function runManagedFlow() {
  const env = process.env;
  const agentIdInEnv = env.SPELLGUARD_AGENT_ID ?? "";
  const existing = readConfig();
  if (existing.config && !existing.config.revoked && existing.config.agentId === agentIdInEnv && existing.config.agentSecret) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        reason: "already_provisioned",
        agentId: existing.config.agentId
      })}
`
    );
    return;
  }
  try {
    const result = await runManagedBootstrap();
    writeConfig({
      scopedToken: "",
      scopedTokenId: "",
      agentId: result.agentId,
      agentSecret: result.agentSecret,
      expiresAt: new Date(Date.now() + 1e3 * 60 * 60 * 24 * 365).toISOString(),
      scopeSummary: { repos: [] },
      spellguardBaseUrl: result.spellguardBaseUrl,
      lastServerSeq: result.frame.seq,
      knownCredentials: [],
      revoked: false
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode: "managed-bootstrap",
        agentId: result.agentId,
        instanceFingerprint: result.instanceFingerprint
      })}
`
    );
  } catch (err) {
    process.stderr.write(
      `spellguard-setup (managed-bootstrap) failed: ${err?.message ?? err}
`
    );
    process.exit(1);
  }
}
main();
