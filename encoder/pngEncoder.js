/*
 * PNG encoder
 * 
 * supported color modes:
 * 
 * 1. platte
 * 2. grayscale
 * 3. rgb
 * 
 * default format: mode:rgb with alpha:true
 */

~function(global) {
	"use strict";
	var defaults = {
		mode : 'rgb',
		colors : 256,
		alpha : true,
		level : 9
	};

	global.exports = {};
	importScripts('../deflate.js');

	var deflate = global.exports.deflate;

	var crc_table = Array(256);

	for ( var i = 0; i < 256; i++) {
		var c = i;
		for ( var j = 0; j < 8; j++) {
			var cr = c & 1;
			c = c >> 1 & 0x7FFFFFFF;
			if (cr) {
				c ^= 0xedb88320;
			}
		}
		crc_table[i] = c;
	}

	function crc32(arr, i, end) {
		var crc = -1;
		for (; i < end; i++) {
			crc = crc_table[crc & 0xFF ^ arr[i]] ^ (crc >> 8 & 0xFFFFFF);
		}
		return ~crc;
	}

	var modes = {
		'rgb' : function(options, buffer, width, height) {
			if (!options.alpha) {
				var arr = new Uint8Array(buffer), L = buffer.byteLength, arr2 = new Uint8Array(L - (L >> 2));
				for ( var i = 0, p = 0; i < L; i++) {
					arr2[p++] = arr[i++];
					arr2[p++] = arr[i++];
					arr2[p++] = arr[i++];
				}
				buffer = arr2.buffer;
			}
			buffer = filter(buffer, options.alpha ? 4 : 3, width, height);

			return {
				IHDR : IHDR(width, height, 8, options.alpha ? 6 : 2),
				IDAT : buffer,
				IEND : new ArrayBuffer(0)
			};
		}
	};

	function IHDR(width, height, bitDepth, colorMode) {
		var ret = new ArrayBuffer(13), view = new DataView(ret);
		view.setUint32(0, width);
		view.setUint32(4, height);
		view.setUint8(8, bitDepth);
		view.setUint8(9, colorMode);
		return ret;
	}

	function filter(buffer, bytesPerPixel, width, height) {
		var scanlineLen = bytesPerPixel * width;
		assert(buffer.byteLength === bytesPerPixel * width * height);
		var arr = new Uint8Array(buffer), filtered = new Uint8Array(height + buffer.byteLength);
		var filters = {};
		var buf1 = new Uint8Array(scanlineLen), // sub
		buf2 = new Uint8Array(scanlineLen), // up
		buf3 = new Uint8Array(scanlineLen), // average
		buf4 = new Uint8Array(scanlineLen); // Paeth
		// for first line, use only filter 0/none, 1/sub, 3/average
		{
			var buf0 = arr.subarray(0, scanlineLen);
			buf1.set(buf0);
			buf3.set(buf0);
			for ( var i = bytesPerPixel, j = 0; i < scanlineLen; i++, j++) {
				buf1[i] -= arr[j];
				buf3[i] -= arr[j] >> 1;
			}
			var filter = filters[[ addFilter(0, buf0), addFilter(1, buf1), addFilter(3, buf3) ].sort()[0]];

			filtered[0] = filter[0];
			filtered.set(filter[1], 1);
		}

		for ( var start = scanlineLen, m = start + 1; start < arr.length;) {
			var end = start + scanlineLen;
			var buf0 = arr.subarray(start, end);
			var i = 0, j = start;
			for (; i < bytesPerPixel; i++, j++) {
				var val = buf0[i];
				buf1[i] = val;
				buf4[i] = buf2[i] = val - arr[j - scanlineLen];
				buf3[i] = val - (arr[j - scanlineLen] >> 1);
			}
			for (; i < scanlineLen; i++, j++) {
				var val = buf0[i];
				var a = arr[j - bytesPerPixel], b = arr[j - scanlineLen], c = arr[j - bytesPerPixel - scanlineLen];
				buf1[i] = val - a;
				buf2[i] = val - b;
				buf3[i] = val - (a + b >> 1);
				var pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - c - c);
				buf4[i] = val - (pa <= pb ? pa <= pc ? a : c : pb <= pc ? b : c);
			}
			var filter = filters[[ addFilter(0, buf0), addFilter(1, buf1), addFilter(2, buf2), addFilter(3, buf3),
				addFilter(4, buf4) ].sort()[0]];

			filtered[m] = filter[0];
			filtered.set(filter[1], m + 1);
			// log('set', m, filter[0]);

			start = end;
			m += scanlineLen + 1;
		}

		return filtered.buffer;

		function addFilter(filter, arr) {
			var vari = variant(arr);
			filters[vari] = [ filter, arr ];
			// log('filter:', filter, vari);
			return vari;
		}
	}

	function variant(arr) {
		var sum = 0, sum2 = 0;
		for ( var i = 0, N = arr.length; i < N; i++) {
			var xi = arr[i];
			sum += xi;
			sum2 += xi * xi;
		}
		return sum2 - sum * sum / N;
	}

	global.addEventListener("message", function(event) {
		var message = event.data;
		// log('start', message.data.byteLength, message.width, message.height,
		// message.options);
		var options = message.options || {};
		options.__proto__ = defaults;

		if (options.alpha) {// auto-detect whether we need alpha channel
			var arr = new Uint8Array(message.data), i = arr.length - 1;
			while (i >= 0 && arr[i] === 255) {
				i -= 4;
			}
			if (i < 0) {
				options.alpha = false;
			}
		}

		var chunks = (modes[options.mode] || modes.rgb)(options, message.data, message.width, message.height);
		var names = Object.keys(chunks);
		chunks.IDAT = deflate(chunks.IDAT, options.level, true);
		var len = 8;
		names.forEach(function(name) {
			len += chunks[name].byteLength + 12;
		});

		var buffer = new ArrayBuffer(len), arr = new Uint8Array(buffer);
		var view = new DataView(buffer);
		view.setUint32(0, 0x89504E47);
		view.setUint32(4, 0x0D0A1A0A);
		var i = 8;
		names.forEach(function(name) {
			var chunk = chunks[name], Len = chunk.byteLength, end = i + 8 + Len;
			view.setUint32(i, Len);
			view.setUint8(i + 4, name.charCodeAt(0));
			view.setUint8(i + 5, name.charCodeAt(1));
			view.setUint8(i + 6, name.charCodeAt(2));
			view.setUint8(i + 7, name.charCodeAt(3));
			var arr2 = new Uint8Array(chunk);
			arr.set(arr2, i + 8);
			view.setUint32(end, crc32(arr, i + 4, end));
			i = end + 4;
		});

		global.postMessage({
			id : message.id,
			buffer : buffer
		}, [ buffer ]);
	});

	function log() {
		global.postMessage({
			type : 'log',
			args : Array.prototype.slice.call(arguments)
		});
	}

	function assert(flag) {
		if (!flag)
			throw flag;
	}
}(this);