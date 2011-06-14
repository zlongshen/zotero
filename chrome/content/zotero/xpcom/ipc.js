/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2011 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

Zotero.IPC = new function() {
	var _libc, _libcPath, _instancePipe, _user32;
	
	/**
	 * Initialize pipe for communication with connector
	 */
	this.init = function() {
		if(!Zotero.isWin && (Zotero.isFx4 || Zotero.isMac)) {	// no pipe support on Fx 3.6
			_instancePipe = _getPipeDirectory();
			if(!_instancePipe.exists()) {
				_instancePipe.create(Ci.nsIFile.DIRECTORY_TYPE, 0700);
			}
			_instancePipe.append(Zotero.instanceID);
			
			Zotero.IPC.Pipe.initPipeListener(_instancePipe, this.parsePipeInput);
		}
	}
	
	/**
	 * Parses input received via instance pipe
	 */
	this.parsePipeInput = function(msg) {
		// remove a newline if there is one
		if(msg[msg.length-1] === "\n") msg = msg.substr(0, msg.length-1);
		
		Zotero.debug('IPC: Received "'+msg+'"');
		
		if(msg === "releaseLock" && !Zotero.isConnector) {
			switchConnectorMode(true);
		} else if(msg === "lockReleased") {
			Zotero.onDBLockReleased();
		} else if(msg === "initComplete") {
			Zotero.onInitComplete();
		}
	}
	
	/**
	 * Broadcast a message to all other Zotero instances
	 */
	this.broadcast = function(msg) {
		if(Zotero.isWin) {		// communicate via WM_COPYDATA method
			// there is no ctypes struct support in Fx 3.6
			// while we could mimic it, it's easier just to require users to upgrade if they
			// want connector sharing
			if(!Zotero.isFx4) return false;
			
			Components.utils.import("resource://gre/modules/ctypes.jsm");
			
			// communicate via message window
			var user32 = ctypes.open("user32.dll");
			
			/* http://msdn.microsoft.com/en-us/library/ms633499%28v=vs.85%29.aspx
			 * HWND WINAPI FindWindow(
			 *   __in_opt  LPCTSTR lpClassName,
			 *   __in_opt  LPCTSTR lpWindowName
			 * );
			 */
			var FindWindow = user32.declare("FindWindowW", ctypes.winapi_abi, ctypes.int32_t,
					ctypes.jschar.ptr, ctypes.jschar.ptr);
			
			/* http://msdn.microsoft.com/en-us/library/ms633539%28v=vs.85%29.aspx
			 * BOOL WINAPI SetForegroundWindow(
			 *   __in  HWND hWnd
			 * );
			 */
			var SetForegroundWindow = user32.declare("SetForegroundWindow", ctypes.winapi_abi,
					ctypes.bool, ctypes.int32_t);
			
			/*
			 * LRESULT WINAPI SendMessage(
			 *   __in  HWND hWnd,
			 *   __in  UINT Msg,
			 *   __in  WPARAM wParam,
			 *   __in  LPARAM lParam
			 * );
			 */
			var SendMessage = user32.declare("SendMessageW", ctypes.winapi_abi, ctypes.uintptr_t,
					ctypes.int32_t, ctypes.unsigned_int, ctypes.voidptr_t, ctypes.voidptr_t);
			
			/* http://msdn.microsoft.com/en-us/library/ms649010%28v=vs.85%29.aspx
			 * typedef struct tagCOPYDATASTRUCT {
			 *   ULONG_PTR dwData;
			 *   DWORD     cbData;
			 *   PVOID     lpData;
			 * } COPYDATASTRUCT, *PCOPYDATASTRUCT;
			 */
			var COPYDATASTRUCT = ctypes.StructType("COPYDATASTRUCT", [
					{"dwData":ctypes.voidptr_t},
					{"cbData":ctypes.uint32_t},
					{"lpData":ctypes.voidptr_t}
			]);
			
			const appNames = ["Firefox", "Zotero", "Nightly", "Aurora", "Minefield"];
			for each(var appName in appNames) {
				// don't send messages to ourself
				if(appName === Zotero.appName) continue;
				
				var thWnd = FindWindow(appName+"MessageWindow", null);
				if(thWnd) {
					Zotero.debug('IPC: Broadcasting "'+msg+'" to window "'+appName+'MessageWindow"');
					
					// allocate message
					var data = ctypes.char.array()('firefox.exe -ZoteroIPC "'+msg.replace('"', '""', "g")+'"\x00C:\\');
					var dataSize = data.length*data.constructor.size;
					
					// create new COPYDATASTRUCT
					var cds = new COPYDATASTRUCT();
					cds.dwData = null;
					cds.cbData = dataSize;
					cds.lpData = data.address();
					
					// send COPYDATASTRUCT
					var success = SendMessage(thWnd, 0x004A /** WM_COPYDATA **/, null, cds.address());
					
					user32.close();
					return !!success;
				}
			}
			
			user32.close();
			return false;
		} else {			// communicate via pipes
			
			// look for other Zotero instances
			var pipes = [];
			var pipeDir = _getPipeDirectory();
			if(pipeDir.exists()) {
				var dirEntries = pipeDir.directoryEntries;
				while (dirEntries.hasMoreElements()) {
					var pipe = dirEntries.getNext().QueryInterface(Ci.nsILocalFile);
					if(pipe.leafName[0] !== "." && (!_instancePipe || !pipe.equals(_instancePipe))) {
						pipes.push(pipe);
					}
				}
			}
			
			if(!pipes.length) return false;
			
			// safely write to instance pipes
			var lib = this.getLibc();
			if(!lib) return false;
			
			// int open(const char *path, int oflag);
			if(Zotero.isFx36) {
				var open = lib.declare("open", ctypes.default_abi, ctypes.int32_t, ctypes.string, ctypes.int32_t);
			} else {
				var open = lib.declare("open", ctypes.default_abi, ctypes.int, ctypes.char.ptr, ctypes.int);
			}
			// ssize_t write(int fildes, const void *buf, size_t nbyte);
			if(Zotero.isFx36) {
			} else {
				var write = lib.declare("write", ctypes.default_abi, ctypes.ssize_t, ctypes.int, ctypes.char.ptr, ctypes.size_t);
			}
			// int close(int filedes);
			if(Zotero.isFx36) {
			} else {
				var close = lib.declare("close", ctypes.default_abi, ctypes.int, ctypes.int);
			}
			
			var success = false;
			for each(var pipe in pipes) {
				var fd = open(pipe.path, 0x0004 | 0x0001);	// O_NONBLOCK | O_WRONLY
				if(fd !== -1) {
					Zotero.debug('IPC: Broadcasting "'+msg+'" to instance '+pipe.leafName);
					success = true;
					write(fd, msg+"\n", msg.length);
					close(fd);
				} else {
					try {
						pipe.remove(true);
					} catch(e) {};
				}
			}
			
			return success;
		}
	}
	
	/**
	 * Get directory containing Zotero pipes
	 */
	function _getPipeDirectory() {
		var dir = Zotero.getZoteroDirectory();
		dir.append("pipes");
		return dir;
	}
	
	/**
	 * Gets the path to libc as a string
	 */
	this.getLibcPath = function() {
		if(_libcPath) return _libcPath;
		
		Components.utils.import("resource://gre/modules/ctypes.jsm");
		
		// get possible names for libc
		if(Zotero.isMac) {
			var possibleLibcs = ["/usr/lib/libc.dylib"];
		} else {
			var possibleLibcs = [
				"libc.so.6",
				"libc.so.6.1",
				"libc.so"
			];
		}
		
		// try all possibilities
		while(possibleLibcs.length) {
			var libPath = possibleLibcs.shift();
			try {
				var lib = ctypes.open(libPath);
				break;
			} catch(e) {}
		}
	
		// throw appropriate error on failure
		if(!lib) {
			Components.utils.reportError("Zotero: libc could not be loaded. Word processor integration "+
				"and other functionality will not be available. Please post on the Zotero Forums so we "+
				"can add support for your operating system.");
			return;
		}
		
		_libc = lib;	
		_libcPath = libPath;
		return libPath;
	}

	/**
	 * Gets standard C library via ctypes
	 */
	this.getLibc = function() {
		if(!_libc) this.getLibcPath();
		return _libc;
	}
}

/**
 * Methods for reading from and writing to a pipe
 */
Zotero.IPC.Pipe = new function() {
	var _mkfifo, _pipeClass;
	
	/**
	 * Creates and listens on a pipe
	 *
	 * @param {nsIFile} file The location where the pipe should be created
	 * @param {Function} callback A function to be passed any data recevied on the pipe
	 */
	this.initPipeListener = function(file, callback) {
		Zotero.debug("IPC: Initializing pipe at "+file.path);
		
		// determine type of pipe
		if(!_pipeClass) {
			var verComp = Components.classes["@mozilla.org/xpcom/version-comparator;1"]
				.getService(Components.interfaces.nsIVersionComparator);
			var appInfo = Components.classes["@mozilla.org/xre/app-info;1"].
				getService(Components.interfaces.nsIXULAppInfo);
			if(verComp.compare("2.2a1pre", appInfo.platformVersion) <= 0) {			// Gecko 5
				_pipeClass = Zotero.IPC.Pipe.DeferredOpen;
			} else if(verComp.compare("2.0b9pre", appInfo.platformVersion) <= 0) {	// Gecko 2.0b9+
				_pipeClass = Zotero.IPC.Pipe.WorkerThread;
			} else {																// Gecko 1.9.2
				_pipeClass = Zotero.IPC.Pipe.Poll;
			}
		}
		
		// make new pipe
		new _pipeClass(file, callback);
	}
	
	/**
	 * Makes a fifo
	 * @param {nsIFile}		file		Location to create the fifo
	 */
	this.mkfifo = function(file) {
		// int mkfifo(const char *path, mode_t mode);
		if(!_mkfifo) {
			var libc = Zotero.IPC.getLibc();
			if(!libc) return false;
			if(Zotero.isFx36) {
				_mkfifo = libc.declare("mkfifo", ctypes.default_abi, ctypes.int32_t, ctypes.string, ctypes.uint32_t);
			} else {
				_mkfifo = libc.declare("mkfifo", ctypes.default_abi, ctypes.int, ctypes.char.ptr, ctypes.unsigned_int);
			}
		}
		
		// make pipe
		var ret = _mkfifo(file.path, 0600);
		return file.exists();
	}
	
	/**
	 * Adds a shutdown listener for a pipe that writes "Zotero shutdown\n" to the pipe and then
	 * deletes it
	 */
	this.writeShutdownMessage = function(file) {
		Zotero.debug("IPC: Closing pipe "+file.path);
		var oStream = Components.classes["@mozilla.org/network/file-output-stream;1"].
			getService(Components.interfaces.nsIFileOutputStream);
		oStream.init(file, 0x02 | 0x10, 0, 0);
		const cmd = "Zotero shutdown\n";
		oStream.write(cmd, cmd.length);
		oStream.close();
		file.remove(false);
	}
}

/**
 * Listens asynchronously for data on the integration pipe and reads it when available
 * 
 * Used to read from pipe on Gecko 5+
 */
Zotero.IPC.Pipe.DeferredOpen = function(file, callback) {
	this._file = file;
	this._callback = callback;
	
	if(!Zotero.IPC.Pipe.mkfifo(file)) return;
	
	this._initPump();
	
	// add shutdown listener
	Zotero.addShutdownListener(Zotero.IPC.Pipe.writeShutdownMessage.bind(null, file));
}

Zotero.IPC.Pipe.DeferredOpen.prototype = {
	"onStartRequest":function() {},
	"onStopRequest":function() {},
	"onDataAvailable":function(request, context, inputStream, offset, count) {
		// read from pipe
		var converterInputStream = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
			.createInstance(Components.interfaces.nsIConverterInputStream);
		converterInputStream.init(inputStream, "UTF-8", 4096,
			Components.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
		var out = {};
		converterInputStream.readString(count, out);
		inputStream.close();
		
		if(out.value === "Zotero shutdown\n") return
		
		this._initPump();
		this._callback(out.value);
	},
	
	/**
	 * Initializes the nsIInputStream and nsIInputStreamPump to read from _fifoFile
	 *
	 * Used after reading from file on Gecko 5+
	 */
	"_initPump":function() {
		var fifoStream = Components.classes["@mozilla.org/network/file-input-stream;1"].
			createInstance(Components.interfaces.nsIFileInputStream);
		fifoStream.QueryInterface(Components.interfaces.nsIFileInputStream);
		// 16 = open as deferred so that we don't block on open
		fifoStream.init(this._file, -1, 0, 16);
		
		var pump = Components.classes["@mozilla.org/network/input-stream-pump;1"].
			createInstance(Components.interfaces.nsIInputStreamPump);
		pump.init(fifoStream, -1, -1, 4096, 1, true);
		pump.asyncRead(this, null);
	}
};

/**
 * Listens synchronously for data on the integration pipe on a separate JS thread and reads it
 * when available
 *
 * Used to read from pipe on Gecko 2
 */
Zotero.IPC.Pipe.WorkerThread = function(file, callback) {
	this._callback = callback;
	
	if(!Zotero.IPC.Pipe.mkfifo(file)) return;
	
	// set up worker
	var worker = Components.classes["@mozilla.org/threads/workerfactory;1"]  
		.createInstance(Components.interfaces.nsIWorkerFactory)
		.newChromeWorker("chrome://zotero/content/xpcom/pipe_worker.js");
	worker.onmessage = this.onmessage.bind(this);
	worker.postMessage({"path":file.path, "libc":Zotero.IPC.getLibcPath()});
	
	// add shutdown listener
	Zotero.addShutdownListener(function() {
		// wait for pending events to complete (so that we don't try to close the pipe before it 
		// finishes opening)
		while(Zotero.mainThread.processNextEvent(false)) {};
		
		// close pipe
		Zotero.IPC.Pipe.writeShutdownMessage(file)
	});
}

Zotero.IPC.Pipe.WorkerThread.prototype = {
	/**
	 * onmessage call for worker thread, to get data from it
	 */
	"onmessage":function(event) {
		if(event.data[0] === "Exception") {
			throw event.data[1];
		} else if(event.data[0] === "Debug") {
			Zotero.debug(event.data[1]);
		} else if(event.data[0] === "Read") {
			this._callback(event.data[1]);
		}
	}
}

/**
 * Polling mechanism for file
 *
 * Used to read from integration "pipe" on Gecko 1.9.2/Firefox 3.6
 */
Zotero.IPC.Pipe.Poll = function(file, callback) {
	this._file = file;
	this._callback = callback;
	
	// create empty file
	this._clearFile();
	
	// no deferred open capability, so we need to poll
	this._timer = Components.classes["@mozilla.org/timer;1"].
		createInstance(Components.interfaces.nsITimer);
	this._timer.initWithCallback(this, 1000,
		Components.interfaces.nsITimer.TYPE_REPEATING_SLACK);
	
	// this has to be in global scope so we don't get garbage collected
	Zotero.IPC.Pipe.Poll._activePipes.push(this);
	
	// add shutdown listener
	Zotero.addShutdownListener(this);
}
Zotero.IPC.Pipe.Poll._activePipes = [];

Zotero.IPC.Pipe.Poll.prototype = {
	/**
	 * Called every second to check if there is new data to be read
	 */
	"notify":function() {
		if(this._file.fileSize === 0) return;
		
		// read from pipe (file, actually)
		var string = Zotero.File.getContents(this._file);
		this._clearFile();
		
		// run command
		this._callback(string);
	},
	
	/**
	 * Called on quit to remove the file
	 */
	"observe":function() {
		this._file.remove();
	},
	
	/**
	 * Clears the old contents of the fifo file
	 */
	"_clearFile":function() {
		// clear file
		var foStream = Components.classes["@mozilla.org/network/file-output-stream;1"].
			createInstance(Components.interfaces.nsIFileOutputStream);
		foStream.init(_fifoFile, 0x02 | 0x08 | 0x20, 0666, 0); 
		foStream.close();
	}
};