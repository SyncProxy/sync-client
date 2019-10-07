// Implements a reactive sync client
// - Reactive mode: client connects to the server automatically, and syncs all reactive tables automatically (at start, or when going online).
// - Non reactive mode: client connects to the server when sync is requested by user, and disconnects when sync finishes.

// User credentials can be set in 2 ways:
// 1°) By using default modal dialog prompt
// 2°) By referencing a custom object/function as an attribute of SyncClient, i.e.: customCredentials="mycredentials()", whose result -typically {login, password}- will be sent as-is to the server.

myalert = function(msg){
	alert(msg);
};

Storage.prototype.setItemSTD = Storage.prototype.setItem;		// save a copy of standard localStorage.setItem() function, which is monkey-patched when using LocalStorage driver
Storage.prototype.removeItemSTD = Storage.prototype.removeItem;		// save a copy of standard localStorage.setItem() function, which is monkey-patched when using LocalStorage driver

function pad(a,b){return(1e15+a+"").slice(-b)}

logMs = function(s){
	var prev;
	if ( typeof now != "undefined" )
		prev = now;
	else
		prev = new Date();
	now = new Date();
	var diff = now.getTime()-prev.getTime();
	console.log(now.getHours() + ":" + now.getMinutes() + ":" + now.getSeconds() + ":" + pad(now.getMilliseconds(),3) + " (" + diff + ") - " + s); 
};

// Simple ployfill for Object.values() function
if ( !Object.values )
	Object.values = (obj)=>Object.keys(obj).map(key=>obj[key]);

// Save original IndexedDB.open() function before disabling it if necessary
const idb = indexedDB || window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB || window.shimIndexedDB;
if ( idb )
	idb.openSTD = idb.open;

// Substitute for jquery .ready() function
(function(funcName, baseObj) {
    funcName = funcName || "docReady";
    baseObj = baseObj || window;
    var readyList = [];
    var readyFired = false;
    var readyEventHandlersInstalled = false;
    function ready() {
        if (!readyFired) {
            readyFired = true;
            for (var i = 0; i < readyList.length; i++) 
                readyList[i].fn.call(window, readyList[i].ctx);
            readyList = [];
        }
    }
    function readyStateChange() {
        if ( document.readyState === "complete" ) {
            ready();
        }
    }
    baseObj[funcName] = function(callback, context) {
        if (typeof callback !== "function") {
            throw new TypeError("callback for docReady(fn) must be a function");
        }
        if (readyFired) {
            setTimeout(function() {callback(context);}, 1);
            return;
        } else
            readyList.push({fn: callback, ctx: context});
        if (document.readyState === "complete") {
            setTimeout(ready, 1);
        } else if (!readyEventHandlersInstalled) {
            if (document.addEventListener) {
                document.addEventListener("DOMContentLoaded", ready, false);
                window.addEventListener("load", ready, false);
            } else {
                document.attachEvent("onreadystatechange", readyStateChange);
                window.attachEvent("onload", ready);
            }
            readyEventHandlersInstalled = true;
        }
    }
})("docReady", window);

SyncClient.prototype.localStorageItemsPrefix = "syncProxy.";

SyncClient.prototype.setItem = function(key, value){
	localStorage.setItemSTD(this.localStorageItemsPrefix + key, value);
}

SyncClient.prototype.getItem = function(key){
	return localStorage.getItem(this.localStorageItemsPrefix + key);
}

SyncClient.prototype.removeItem = function(key){
	localStorage.removeItemSTD(this.localStorageItemsPrefix + key);
}

SyncClient.prototype.defaultParams = {
	"protocol": "wss",						// ws / wss
	"serverUrl": "my.syncproxy.com",		// Default: "my.syncproxy.com";
	"serverPort": 4501,						// Default: 4501
	"proxyId": "",							// ID of the server-side sync proxy to sync with. If blank, user's default sync proxy will be retrieved by sync server
	"connectorType": "IndexedDB",			// Client database connector: IndexedDB / WebSQL / SQLite / LocalStorage / IonicStorage
	"dbName": "",							// Client databse name
	"dbLocation": "default",				// Client databse location (used by SQLite driver)
	"autoUpgradeDB": "true",				// If set to false, database's structure will not be upgraded by sync (in that case, app should manage schema updates by itself).
	"autoInit": true,						// If true, sync client will be started automatically. If false, sync client should be created by calling SyncClient.initClient(params)
	"reactiveSync": true,					// If true, enables reactive sync. Reactivity for each table + direction (server->client and client->server) is configured on server side
	"syncButton": true,						// If true, enables reactive sync. Reactivity for each table + direction (server->client and client->server) is configured on server side
	"tablesToSync": [],						// List of tables to sync with sync profiles (sync direction + reactivity)
	"customCredentials": "",				// Custom credential function. Typically returns a {login, password} object which will be sent as-is to the server.
	"login": "",							// Default user login.
	"loginSource": "",						// User login source for sync server, for instance: "document.getElementById('inputLogin').value"
	"passwordSource": "",					// User password source for sync server, for instance: "document.getElementById('inputPassword').value"
	"welcomeMessage": "To begin, please press Sync button",
	"onSyncEnd": "console.log('onSyncEnd')"				// Custom function called after sync end
};

function SyncClient(params){
	// Script params can be passed directly in <script> tag referring syncclient.js
	for ( var p in SyncClient.prototype.scriptParams ){
		if ( params && (typeof params[p] != "undefined") )
			this[p] = params[p];
		else 
			this[p] = SyncClient.prototype.defaultParams[p];
	}
	var reactive = false;
	this.lastAuthFailed = false;
	this.serverConnection = null;
	this.connector = null;
	this.showStatus = true;
	this.resetSyncsPending();
	var self = this;

	this.disableIndexedDBOpen();
	
	includeFile("db-connectors/base.js")
	.then(()=>{
		if ( self.connectorType == "IonicStorage" ){
			self.dbName = "_ionicstorage";		// name of the database of Ionic Storage key-value pair store when used in IndexedDB (and WebSQL ?)
			self.connectorType = DBConnector.getPreferredIonicStorage();
			self.tablesToSync = ["_ionickv"];
		}
		if ( !(self.tablesToSync instanceof Array) )
			self.tablesToSync = self.tablesToSync.split(',');		// tablesToSync may be passed as a list of tables separated with ","
		if ( (self.connectorType == "WebSQL") || (self.connectorType == "SQLite") )
			return includeFile("db-connectors/sqlite-base.js");
	})
	.then(()=>{
		return self.loadConnector(self.connectorType, self.dbName);
	})
	.then(()=>{
		return includeFile("libs/toastada.js");
	})
	.then(()=>{
		return includeFile("libs/toastada.css", "link");
	})
	.then(()=>{
		self.loadSchema();
		var upgradePromise;
		if ( self.upgradeNeeded(self.schema) ){
			upgradePromise = self.upgradeDatabase({version:self.schema.version, Tables:self.schema.Tables});
		}
		else
			upgradePromise = Promise.resolve(false);		// no recent change in schema
		return upgradePromise
		.then(()=>includeFile("sync-client-custom.js"))
		.then(()=>{ self.loadSyncProfile(); reactive = this.hasReactiveSync();})
		.then(()=>{
			if ( (reactive || !this.getTablesToSync() || !this.getTablesToSync().length) && self.isOnline() )
				return self.connect()		// on connected will start a full sync
				.catch(err=>self._onConnectionError(err));
		});
	})
	.then(()=>{
		if ( self.syncButton ){
			docReady(function(){self.createSyncButton();});
		}
		if (!this.getSyncClientCode() && this.welcomeMessage && (this.welcomeMessage != ""))
			this.showToast(this.welcomeMessage)
	})
	.catch(err=>console.log(err));
	
	// Reactive sync needs to be notified of changes in online status.
	//if ( reactive )
	{
		window.addEventListener('online',  function(){self._onOnline();});
		window.addEventListener('offline', function(){self._onOffline()});
	}
	window.addEventListener('syncPending', function(e){self._onSyncPending(e.detail.reactive)});
	window.addEventListener('syncEnd', function(e){if (self.onSyncEnd) eval(self.onSyncEnd);});		// call a custom function if any
}

/* SyncClient.prototype.disableIndexedDBOpen = function(){
	// Patch original database open function used by app, to avoid possible database lock conflict with sync client during database upgrade.
	if ( (this.connectorType == "IndexedDB") || ((this.connectorType == "IonicStorage") && (DBConnector.getPreferredIonicStorage() == "IndexedDB"))){
		if ( (this.autoUpgradeDB.toString() != "false") && (!this.getSyncClientCode() || (this.getMustUpgrade() == "true"))){
			idb.indexedDBOpenDisabled = true;
			idb.open = function(dbName){
				console.log("IndexedDB.open() function has been disabled until sync complete and database ready");
				idb.restartNeeded = true;
				return null;
			};
		}
	}
	else if ( idb )
		delete idb.openSTD;		// backup of IndexedDB.open() function is not needed: reset it
} */

SyncClient.prototype.disableIndexedDBOpen = function(){
	// Patch original database open function used by app, to avoid possible database lock conflict with sync client during database upgrade.
	if ( 
		((this.connectorType == "IndexedDB") || ((this.connectorType == "IonicStorage") && (DBConnector.getPreferredIonicStorage() == "IndexedDB"))) && 
		((this.autoUpgradeDB.toString() != "false") && (!this.getSyncClientCode() || (this.getMustUpgrade() == "true")))
		){
		idb.indexedDBOpenDisabled = true;
		idb.open = function(dbName){
			console.log("IndexedDB.open() function has been disabled until sync complete and database ready");
			idb.restartNeeded = true;
			return null;
		};
	}
	else if ( idb && idb.indexedDBOpenDisabled){
		// Backup of IndexedDB.open() function is not needed: reset it
		idb.open = idb.openSTD;
		delete idb.openSTD;
		idb.indexedDBOpenDisabled = false;
	}
}

SyncClient.prototype.resetIndexedDBOpen = function(){
	// Reset original database open function used by app, if it was patched (to prevent database version collision with app), restore original open
	var self = this;
	if ( (this.connectorType == "IndexedDB") || ((this.connectorType == "IonicStorage") && (DBConnector.getPreferredIonicStorage() == "IndexedDB"))){
		if ( !idb )
			return;
		if (idb && idb.indexedDBOpenDisabled){
			delete idb.indexedDBOpenDisabled;
			idb.open = function(dbName, version, cb){
				idb.restartNeeded = false;		// give a chance to app to avoid restart if it calls db.open() again (restart will apply only if app calls db.open() once at launch)
				return idb.openSTD(dbName, version, cb);
			};
			window.setTimeout(function(){
				if ( idb.restartNeeded ){
					console.log("App attempt to open IndexedDB on start was blocked by sync client's database update. App will restart.");
					self.showToast("Application needs to restart", "warning");
					window.setTimeout(function(){
						location.reload();
					}, 3000);
				}
				else
					console.log("IndexedDB.open() was reset to original");
			}, 1000);
		}
	}
};

SyncClient.prototype.saveSchema = function(schema){
	this.setItem(this.proxyId + ".schema", JSON.stringify(schema));
};

SyncClient.prototype.loadSchema = function(){
	var s = this.getItem(this.proxyId + ".schema");
	if ( s )
		this.schema = JSON.parse(s);
	return this.schema;
};

// Compare schema version and current DB version to decide wether to upgrade database.
SyncClient.prototype.upgradeNeeded = function(schema){
	var needed = ( (this.autoUpgradeDB.toString() != "false") && schema && (schema.version > this.connector.getDBVersion()) );
	if ( !needed )
		this.saveMustUpgrade(false);
	return needed;
};

SyncClient.prototype.saveSyncProfile = function(syncProfile){
	this.setItem(this.proxyId + ".syncProfile", JSON.stringify(syncProfile));
};

SyncClient.prototype.loadSyncProfile = function(syncProfile){
	var s = this.getItem(this.proxyId + ".syncProfile");
	if ( s )
		this.syncProfile = JSON.parse(s);
	return this.syncProfile;
};

SyncClient.prototype.cacheSyncProfile = function(syncRules){
	if ( syncRules != "clientTablesToSync" ){
		this.syncProfile = [];
		for ( var r in syncRules ){
			var table = {};
			table[r] = syncRules[r];
			this.syncProfile.push(table);
		}
		this.saveSyncProfile(this.syncProfile);
	}
};

///////////////
// Utilities //
///////////////
function includeFile(url, type){
	url = url.toLowerCase();
	if ( !type )
		type = "script";
	return new Promise(function(resolve, reject){
		var prop = "src";
		if ( type == "link" )
			prop = "href";
		if ( document.querySelector(type + '[' + prop + '$="' + url + '"]') )
			return resolve("Already included");		// do not include the same file twice
		var root = document.querySelector('script[src$="sync-client.js"]').getAttribute('src').split('/')[0] + "/";
		if ( root.indexOf("sync-client") == -1 )
			root += "sync-client/";
		var script = document.createElement(type);
		if ( type == "script" )
			script.type = 'text/javascript';
		else if ( type == "link" )
			script.rel = "stylesheet";
		script[prop] = root + url;
		script.id = url;
		script.onload = function(e){
			script.loaded = true;
			resolve("OK");
		};
		document.getElementsByTagName('head')[0].appendChild(script);
	});
}

function Translate(message){
	return message;
};

SyncClient.prototype.loadConnector = function(connectorType, dbName){
	var self = this;
	return includeFile("db-connectors/" + connectorType.toLowerCase() + ".js")
	.then(function(){
		self.connector = eval("new DBConnector" + connectorType + "('" + dbName + "', self)");
		console.log("Data connector " + connectorType + " successfully loaded");
	});
};


////////////////////////////
// Status change handlers //
////////////////////////////
SyncClient.prototype.sendEvent = function(msg, detail){
	if ( CustomEvent )
		window.dispatchEvent(new CustomEvent(msg, {detail:detail}));
};

SyncClient.prototype.resetSyncsPending = function(){
	this.clientSyncsPending = 0;
	this.serverSyncsPending = 0;
}

SyncClient.prototype._onOffline = function(){
	this.showToast("Offline", "warning");
	this.resetSyncsPending();
	this.lastSyncFailed = false;
	this.updateSyncButton();
	if (this.serverConnection){
		this.serverConnection.close();
		this.serverConnection = null
	}
};

SyncClient.prototype._onOnline = function(){
	this.showToast("Online", "success");
	this.showNextConnectAttempt = true;
	var self = this;
	this.updateSyncButton();
	window.setTimeout(function(){
		if (self.hasReactiveSync()){
			console.log("Reactive sync mode...");
			self.fullSync();
		}
	}, 1000);
};

SyncClient.prototype._onConnected = function(){
	var self = this;
	this.disableAutoReconnect = true;
	if ( this.connectInterval )
		this.stopAutoReconnect();
	this.lastSyncFailed = false;
	this.connected = true;
	this.updateSyncButton();
	if ( this.hasReactiveSync() )
		window.setTimeout(function(){self.fullSync();}, 0);
	this.sendEvent("connected");
};

SyncClient.prototype._onAuthenticated = function(){
	//this.disableAutoReconnect = false;
	this.sendEvent("authenticated");
};

SyncClient.prototype._onConnectionError = function(){
	this.resetSyncsPending();
	this.lastSyncFailed = true;
	delete this.serverConnection;
	this.connected = false;
	if (this.showStatus || this.showNextConnectAttempt)
		this.showToastUnique("Could not contact server", "error");
	this.showNextConnectAttempt = false;
	this.updateSyncButton();
	this.autoReconnect();
	this.sendEvent("connectionError");
};

SyncClient.prototype._onDisconnected = function(){
	this.resetSyncsPending();
	this.serverConnection = null;
	this.connected = false;
	if (this.showStatus)
	this.showToast("Disconnected", "warning");
	this.updateSyncButton();
	this.autoReconnect();
	this.sendEvent("disconnected");
};

SyncClient.prototype._onSyncPending = function(reactive){
	var self = this;
	self.updateSyncButton();
	if (!reactive)
		this.showToastUnique("Sync started...", "info");
};

SyncClient.prototype._onSyncEnd = function(reactive){
	//this.resetSyncsPending();
	this.updateSyncButton();
	if ( !reactive )
		this.showToast("Sync ended successfully", "success");
	this.resetIndexedDBOpen();		// reset app's normal database open function
	if ( !this.mustUpgrade )
		this.sendEvent("syncEnd", {reactive:reactive});
};

SyncClient.prototype._onSyncCancel = function(msg){
	this.showToast(msg, "warning");
	this.resetSyncsPending();
	this.updateSyncButton();
	this.sendEvent("syncCancel");
};

SyncClient.prototype._onSyncError = function(err){
	// Reset keys of changes being sent.
	this.resetSendings();

	var self = this;
	if ( (err == "Cancel") || (err.err == "AUTH FAILURE") || (err.err == "SESSION FAILURE") ){
		this.stopAutoReconnect();
		this.disableAutoReconnect = true;
		if ( this.password ) delete this.password;
		delete this.sessionId;
	}
	if ( err.warning && err.message )
		this.showToast(err.message, "warning");
	else if ( err.warning )
		this.showToast(err.warning, "warning");
	else if (err != "Cancel"){
		this.lastSyncFailed = true;
		if ( err == "Not authenticated" )
			this.showToast("Not authenticated", "error");
		if ( err && err.err && err.message && (err.message.toString() != "[object Object]") )
			this.showToast(err.err + ": " + err.message, "error");
		else if (err && err.err)
			this.showToast(err.err, "error");
		else if (err && err.message)
			this.showToast(err.message);
		else if (typeof err == "string")
			this.showToast("Sync error: " + err, "error");
		else
			this.showToast("Sync error", "error");
	}
	if ( err.err == "SESSION FAILURE" )
		window.setTimeout(function(){self.showToast("Press Sync to start a new session", "info");}, 5000);
	this.resetSyncsPending();
	this.updateSyncButton();	
	this.sendEvent("syncError");
};

SyncClient.prototype.isOnline = function(){
	return navigator.onLine;
};

SyncClient.prototype.isConnected = function(){
	if ( !this.connected )
		return false;
	return true;
};

SyncClient.prototype.isAuthenticated = function(){
	if ( this.sessionId )
		return true;
	else
		return false;
};


/////////////////////////////////
// User notification functions //
/////////////////////////////////
SyncClient.prototype.showToastUnique = function(msg, style){
	this.removeAllToasts();
	this.showToast(msg,style);
};

SyncClient.prototype.showToast = function(msg, style){
	// Styles: success, info, warning, error
	if ( !style )
		style = "warning";
		// style = "succe";
	switch(style){
		case "warning": 
			toastada.warning(msg);
			break;
		case "success": 
			toastada.success(msg);
			break;
		case "info": 
			toastada.info(msg);
			break;
		case "error": 
			toastada.error(msg);
			break;
	};
};

SyncClient.prototype.showAlert = function(msg){
	var self = this;
	var modal = new tingle.modal({
		// Show a tingle modal dialog (https://robinparisi.github.io/tingle/)
		footer: true,
		stickyFooter: false,
		closeMethods: ['overlay', 'button', 'escape'],
		closeLabel: "Close",
		cssClass: ['custom-class-1', 'custom-class-2'],
		onOpen: function() {
		},
		onClose: function() {
		}
	});
	modal.setContent("<p>" + msg + "</p>" );
	modal.addFooterBtn('OK', 'tingle-btn tingle-btn--primary tingle-custom-btn', function() {
		modal.close();
	});
	document.addEventListener("keydown", function(evt){
		switch ( evt.which ){
			case 13:		// add missing support for "Enter" key validation.
			case 27:		// Cancel
				modal.close();
		}
	});
	modal.open();
};

///////////////////////////////
// Servers messages handlers //
///////////////////////////////
SyncClient.prototype.onServerMessage = function(msg, synchronousRequestType){
	// Types of server messages handled:
	// * serverSync => contains a list of modified tables)
	console.log('Received: ' + msg);
	var self = this;
	return new Promise(function(resolve,reject){
		var data;
		try{data = JSON.parse(msg);}
		catch(e){
			self.showToast("Bad server data format", "error");
			return reject("Bad server data format");
		}
		if ( data && data.err ){
			self._onSyncError(data);
			//return reject(data);
			return resolve(data);
		}
		if ( data && data.warning ){
			self._onSyncError(data);
			// self.handleServerWarning(data);
			return resolve(data);
		}
		if ( synchronousRequestType == "authentication"){
			console.log("Authenticated sessionId:" + data.sessionId);
			self.sessionId = data.sessionId;
			if ( data.clientCode )
				self.saveSyncClientCode(data.clientCode);
			self.saveUserName(data.userName, data.userLastName)
			self._onAuthenticated();
			return resolve(data);
		}
		if ( data.serverSync ){
			// A server sync has been orderd by server => json.serverSync contains the list of tables to sync.
			if ( !self.serverSyncsPending && !self.clientSyncsPending ){
				self.serverSync(true, data.serverSync)
				.then(res=>resolve(res));
			}
			else
				return resolve();
		}
/*		else if ( data.schema && data.schema.Tables && data.schema.Tables.length ){
			if (self.clientSyncsPending > 0)
				self.clientSyncsPending--;
			self.onSchemaUpdate(data.schema);
			return resolve();
		}*/
		else if ( data.schema ){
			if (self.clientSyncsPending > 0)
				self.clientSyncsPending--;
			if ( data.schema.Tables && data.schema.Tables.length )
				self.onSchemaUpdate(data.schema);
			return resolve();
		}
		else if (data.syncRules){
			// User sync profile received
			if (self.clientSyncsPending > 0)
				self.clientSyncsPending--;
			if ( data.syncRules == {} )
				reject("No tables to sync");
			else{
				self.cacheSyncProfile(data.syncRules);
				return self.getAndSendClientChanges(self.syncType == 2)
				.then(()=>resolve());
			}
		}
		else if ( data.clientChangesReceived ) {
			// Server has received client changes
			if (self.clientSyncsPending > 0)
				self.clientSyncsPending--;
			if ( data.clientChangesReceived == -1 ){
				console.log("No client changes");
				logMs("CLIENT SYNC END");
				if (self.syncType == 2)
					self._onSyncEnd(true);
				else if (!self.serverSyncsPending)
					self.serverSync()
					.then(()=>resolve());
				else
					resolve();
			}
			else{
				console.log("Client changes sent");
				if ( data.conflicts )
					self.showToast(data.conflicts + " conflicted data");
				self.resetSentChanges()
				.then(res=>logMs("CLIENT SYNC END"))
				.then(()=>{
					// If sync pending type was reactive, sync is over after client changes are received. Otherwise (full sync), it will terminate after server sync.
					if (self.syncType == 2){
						// Sync is over, unless client still has changes to send
						if (!self.allChangesSent )
							self.clientSync(true);
						else
							self._onSyncEnd(true);
					}
					else if ( !self.serverSyncsPending)
						self.serverSync()
						.then(()=>resolve());
					else
						resolve();
				})
				.then(()=>resolve());
			}	
		}
		else if ( data.Deletes || data.Updates || data.Inserts ){
			// Changes received from server.
			self.handleServerChanges(data)
			.then(res=>{handledTables = res;})
			.then(()=>self.endServerSync(handledTables))
			.then(res=>resolve(res));
		}
		else if ( data.end ){
			// Server sync just ended
			logMs("SERVER SYNC END");
			if (self.serverSyncsPending > 0)
				self.serverSyncsPending--;
			self._onSyncEnd(self.syncType == 2);
		}
		else{
			self._onSyncError("Bad server response");
			return resolve("Bad server response");
		}
	});
};

SyncClient.prototype.showMustUpgradeWarning = function(){
	this._onSyncCancel("Database initialization... Application will restart", "warning");
	window.setTimeout(function(){
		location.reload();
	}, 3000);
};

SyncClient.prototype.onSchemaUpdate = function(schema){
	// Schema update received
	console.log("onSchemaUpdate");
	this.saveSchema(schema);
	this.mustUpgrade = this.upgradeNeeded(schema);
	this.saveMustUpgrade(true);
	if (this.mustUpgrade)
		this.showMustUpgradeWarning();
};


////////////////////
// Authentication //
////////////////////
SyncClient.prototype.promptUserLogin = function(){
// Open a modal dialog to prompt user's crendentials. The result is returned as a {login, password} object in the promise's resolve().
	var self = this;
	if ( !self.login )
		self.login = "";
	return new Promise(function(resolve,reject){
		var login = "";
		var password = "";
		if ( (typeof self.loginModal != "undefined") && self.loginModal.isOpen() )
			return;
		self.loginModal = new tingle.modal({
			// Show a tingle modal dialog (https://robinparisi.github.io/tingle/)
			footer: true,
			stickyFooter: false,
			closeMethods: ['overlay', 'button', 'escape'],
			closeLabel: "Close",
			cssClass: ['custom-class-1', 'custom-class-2'],
			onOpen: function() {
			},
			onClose: function() {
				reject("Cancel");
			},
			beforeClose: function() {
				login = document.getElementById("spLogin").value;
				password = document.getElementById("spPassword").value;
				if ( !password )
					password = "";
				self.setItem(self.proxyId + ".lastLogin", login);
				return true; // close the dialog
				// return false; // nothing happens
			}
		});
		var showFailure = "hidden";
		if ( self.lastAuthFailed )
			showFailure = "show";
		self.loginModal.setContent("<h1 class='tingle-custom-title'>Please enter your sync login</h1>"
			+ "<label class='tingle-custom-label'>E-mail:</label>&emsp;<input id='spLogin' class='tingle-custom-input' onkeydown='document.getElementById(\"lblAuthFailure\").style.visibility=\"hidden\";' value='" + self.login + "' onpaste='return false;'/><br><br>"
			+ "<label class='tingle-custom-label'>Password:</label>&emsp;<input id='spPassword' type='password' class='tingle-custom-input' onkeydown='document.getElementById(\"lblAuthFailure\").style.visibility=\"hidden\";' value=''/><br><br>"
			+ "<p class='tingle-custom-text'>If you don't have a login yet, please go to <a href='www.syncproxy.com'>www.syncproxy.com</a> to signup and join or create a sync group.</p>"
			+ "<p id='lblAuthFailure' class='tingle-custom-text tingle-red-text' style='visibility:" + showFailure + "'>Authentication failure</p>");
		self.loginModal.addFooterBtn('OK', 'tingle-btn tingle-btn--primary tingle-custom-btn', function() {
			if ( document.getElementById("spLogin").value == "" )
				return;
			self.loginModal.close();
			resolve({login:login, password:password});
		});
		self.loginModal.addFooterBtn('Cancel', 'tingle-btn tingle-btn--default tingle-custom-btn', function() {
			self.loginModal.close();
			reject("Cancel");
		});
		// document.getElementById("spLogin").parentElement.onkeydown = function(evt){
		document.addEventListener("keydown", function(evt){
			switch ( evt.which ){
				case 13:		// add missing support for "Enter" key validation.
					self.loginModal.close();
					resolve({login:login, password:password});
					break;
				case 27:		// add rejection on Esc pressed (cancel)
					reject("Cancel");
			}
		});
		self.loginModal.open();
	});
};

SyncClient.prototype.getCredentials = function(){
	// Get credential from source objects within application, or using a modal to prompt login/password.
	if ( this.loginSource && this.passwordSource ){
		this.login = eval(this.loginSource);
		this.password = eval(this.loginPassword);
	}
	if ( this.login && this.password )
		return Promise.resolve({login:this.login, password:this.password});
	if ( this.getItem(this.proxyId + ".lastLogin") )
		this.login = this.getItem(this.proxyId + ".lastLogin");
	var self = this;
	var cred = this.getCustomCredentials();		// source objects may be defined to get credentials from.
	if ( cred )
		return Promise.resolve(cred);
	else
		return includeFile("libs/tingle.js")
		.then(()=>includeFile("libs/tingle.css", "link"))
		.then(()=>includeFile("libs/tingle-custom.css", "link"))
		.then(()=>{return self.promptUserLogin();})
		.then(res=>{if (!res.login) return null; self.login = res.login; self.password = res.password; return res;})
};

SyncClient.prototype.getCustomCredentials = function(){
	if ( !this.customCredentials || (this.customCredentials == "") )
		return null;
	return eval(this.customCredentials);
};

////////////////////
// Sync functions //
////////////////////
SyncClient.initClient = function(params){
	SyncClient.defaultClient = new SyncClient(SyncClient.prototype.scriptParams);
};

SyncClient.getScriptParams = function() {
	var scripts = document.getElementsByTagName('script');
	lastScript = scripts[scripts.length-1];
	var result = {};	
	for ( var p in SyncClient.prototype.defaultParams ){
		var attr = lastScript.getAttribute(p);
		if ( attr )
			result[p] = attr;
		else
			result[p] = SyncClient.prototype.defaultParams[p];
	}
	return result;
}

// If SyncClient uses IndexedDB connector with autoUpgradeDB option, disable original IndexedDB.open() function temporarilly (without waiting for SyncClient initialization), to prevent main app to block database before it is upgraded.
var tmpParams = SyncClient.getScriptParams();
if ( (tmpParams.connectorType == "IndexedDB") || (!tmpParams.connectorType && (SyncClient.prototype.defaultParams.connectorType == "IndexedDB")) ){
	if ( (tmpParams.autoUpgradeDB == "true") || (!tmpParams.autoUpgradeDB && (SyncClient.prototype.defaultParams.autoUpgradeDB == "true")) ){
		idb.indexedDBOpenDisabled = true;
		idb.open = function(dbName){
			console.log("IndexedDB.open() function has been disabled until sync complete and database ready");
			idb.restartNeeded = true;
			return null;
		};
	}
}

SyncClient.prototype.getSyncIcon = function(){
	// "offline" = offline (no network)
	// "sync" = not authenticated (has a network connection BUT not connected with server OR not authenticated)
	// "sync-ok" = connected with server AND authenticated (valide sessionId)
	// "auto sync" = connected with server AND authenticated with reactive sync
	// "sync error" = last sync failed
	if ( this.lastSyncFailed )
		return "sync-error";
	else if (!this.isOnline() )
		return "offline";
	else {
		// Online
		if ( !this.mustUpgrade ){
			var reactive = this.hasReactiveSync();
			if ( this.isConnected() && this.isAuthenticated() && reactive )
				return "sync-auto";
			else if ( this.isConnected() && this.isAuthenticated() )
				return "sync-ok";
			else if ( !reactive || !this.connectInterval )
				// Display "sync" button (unless reactive mode and last connect attempt failed)
				return "sync";
		}
		return "online";
	}
};

SyncClient.prototype.updateSyncButton = function(pressed){
	this.syncIcon = this.getSyncIcon();
	if ( !this.syncBtn ){
		this.syncBtn = document.createElement("img");
		// this.syncBtn = document.createElement("button");
		this.syncBtn.alt = "Sync";
	}
	this.syncBtn.alt = "";
	// if ( this.syncBtn.src != "sync-client/libs/" + this.syncIcon + ".png" )
		// this.syncBtn.src = "sync-client/libs/" + this.syncIcon + ".png";
	this.syncBtn.className = "sync-button " + this.syncIcon;
	if ( this.mustUpgrade || !this.isOnline() )
	//if ( !this.isOnline() )
		this.syncBtn.className += " sync-button-disabled";
	else if ( pressed )
		this.syncBtn.className += " sync-button-pressed";
	if ( this.clientSyncsPending || this.serverSyncsPending )
		this.syncBtn.className += " sync-button-rotating";
};

SyncClient.prototype.initSyncButtonPos = function(){
	// Center button horizontally at the bootom
	this.syncBtn.style.top = (Math.max(parseInt(document.body.scrollHeight), window.innerHeight || 0) - parseInt(this.syncBtn.offsetHeight)) + "px";
	this.syncBtn.style.left = parseInt(parseInt(window.innerWidth)/2 - parseInt(this.syncBtn.offsetWidth)/2) + "px";
};

SyncClient.prototype.createSyncButton = function(){
	includeFile("libs/sync-button.css", "link");
	var self = this;
	window.onresize = function(e){
		self.initSyncButtonPos(e);
	};
	this.updateSyncButton();
	window.setTimeout(function(){
		// Set button position, once its height & width are known (therefore we use a timeout)
		self.initSyncButtonPos();
	}, 1000);
	const getPageXY = function(e){
		if ( (typeof TouchEvent != "undefined") && (e instanceof TouchEvent) && e.changedTouches[0])
			return {x: e.changedTouches[0].pageX, y: e.changedTouches[0].pageY};
		else
			return {x: e.pageX, y: e.pageY};
	};
	this.syncBtn.drag = function(e){
		e.preventDefault();
		self.updateSyncButton(true);
		self.syncBtn.moved = false;
		self.syncBtn.obj = self.syncBtn;
		var pageXY = getPageXY(e);
		self.syncBtn.prev_x = pageXY.x - self.syncBtn.obj.offsetLeft;
		self.syncBtn.prev_y = pageXY.y - self.syncBtn.obj.offsetTop;
	};
	this.syncBtn.move = function(e) {
		if ( (typeof TouchEvent != "undefined") && (e instanceof TouchEvent) && (e.target != self.syncBtn) )
			return;
		var pageXY = getPageXY(e);
		// If the object specifically is selected, then move it to the X/Y coordinates that are always being tracked.
		if (self.syncBtn.obj) {
			if ( Math.pow(self.syncBtn.prev_x + self.syncBtn.x - pageXY.x, 2) + Math.pow(self.syncBtn.prev_y + self.syncBtn.y - pageXY.y, 2) > 2 )		// click is tolerant to mini-movements (max 1px on X and 1px on Y)
				self.syncBtn.moved = true;
			self.syncBtn.x = pageXY.x; // X coordinate based on page, not viewport.
			self.syncBtn.y = pageXY.y; // Y coordinate based on page, not viewport.
			self.syncBtn.obj.style.left = (pageXY.x - self.syncBtn.prev_x) + 'px';
			self.syncBtn.obj.style.top = (pageXY.y - self.syncBtn.prev_y) + 'px';
		}
		if ( parseInt(self.syncBtn.offsetLeft) > parseInt(window.innerWidth) - parseInt(self.syncBtn.offsetWidth) )
			self.syncBtn.style.left = (parseInt(window.innerWidth) - parseInt(self.syncBtn.offsetWidth)) + "px";
		if ( self.syncBtn.offsetLeft < 0 )
			self.syncBtn.style.left = "0px";
		if ( self.syncBtn.offsetTop < 0 )
			self.syncBtn.style.top = "0px";
		// if ( parseInt(self.syncBtn.offsetTop) > parseInt(window.innerHeight) - parseInt(self.syncBtn.offsetHeight) - 3 )
			// self.syncBtn.style.top = (parseInt(window.innerHeight) - parseInt(self.syncBtn.offsetHeight) - 3) + "px";
		var hMax = Math.max(parseInt(document.body.scrollHeight), window.innerHeight || 0);
		if ( parseInt(self.syncBtn.offsetTop) > hMax - parseInt(self.syncBtn.offsetHeight) - 3 )
			self.syncBtn.style.top = (hMax - parseInt(self.syncBtn.offsetHeight) - 3) + "px";
	};
	this.syncBtn.drop = function(e) {
		var clicked = self.syncBtn.obj && !self.syncBtn.moved;
		self.syncBtn.moved = false;
		self.syncBtn.obj = false;
		self.updateSyncButton(false);
		// Handle click unless button is disabled.
		if (clicked && (self.syncBtn.className.indexOf("sync-button-disabled") == -1))
			window.setTimeout(function(){self.syncButtonPressed();},0);
	};
	document.body.appendChild(this.syncBtn);
	this.syncBtn.onmousedown = this.syncBtn.drag;
	this.syncBtn.ontouchstart = this.syncBtn.drag;
	document.onmousemove = this.syncBtn.move;
	document.ontouchmove = this.syncBtn.move;
	document.onmouseup = this.syncBtn.drop;
	document.ontouchend = this.syncBtn.drop;
	document.onmouseleave = this.syncBtn.drop;
};

SyncClient.prototype.syncButtonPressed = function(){
	this.stopAutoReconnect();
	if (this.clientSyncsPending || this.serverSyncsPending)
		this.stopSync();
	else
		this.fullSync();
};

SyncClient.prototype.stopSync = function(){
};

SyncClient.prototype.getSyncClientCode = function(){
	return this.getItem(this.proxyId + ".syncClientCode");
};

SyncClient.prototype.saveSyncClientCode = function(code){
	this.setItem(this.proxyId + ".syncClientCode", code);
};

SyncClient.prototype.getMustUpgrade = function(){
	if ( this.autoUpgradeDB == "false")
		return false;
	return this.getItem(this.dbName + ".mustUpgrade");
};

SyncClient.prototype.saveMustUpgrade = function(val){
	console.log("this.autoUpgradeDB=" + this.autoUpgradeDB);
	if ( this.autoUpgradeDB == "false" )
		return;
	this.setItem(this.dbName + ".mustUpgrade", val);
};

SyncClient.prototype.saveUserName = function(name, lastName){
	this.setItem(this.proxyId + ".lastUserName", name);
	this.setItem(this.proxyId + ".lastUserLastName", lastName);
};

SyncClient.prototype.authenticate = function() {
	if ( this.isAuthenticated() )
		return Promise.resolve(true);
	var self = this;
	return this.getCredentials()
	.then(res=>{return self.sendAuthenticationRequest(res);})
};

SyncClient.prototype.sendRequest = function(data, synchronousRequest){
	// If synchronousRequest is defined, client expects an immediate response from the server (otherwise, response may be sent anytime, like any other server-initated message).
	var self = this;
	if ( self.sessionId )
		data.sessionId = self.sessionId;
	return new Promise(function(resolve,reject){
		self.connect()
		.then(()=>{
			// Does the client expect an immediate response from the server ?
			if (!self.serverConnection)
				return reject("Server connection is no longer valid");
			if ( synchronousRequest ){
				self.serverConnection.onmessage = function(event){
					return self.onServerMessage(event.data, synchronousRequest)
					.then(res=>{
						if ( res.err )
							return reject(res);
						return resolve(res);
					})
					.catch(err=>reject(err));
				};
			}
			if ( synchronousRequest && (synchronousRequest != "authentication") && !self.isAuthenticated() )
				return reject("Not authenticated");
			if ( !synchronousRequest ){
				self.setDefaultServerMessageHandler();
				resolve();
			}
			self.serverConnection.send(JSON.stringify(data));
		});
	})
};

SyncClient.prototype.sendAuthenticationRequest = function(data) {
	data.proxyId = this.proxyId;
	var clientCode = this.getSyncClientCode();
	if ( clientCode )
		data.clientCode = clientCode;
	this.authRequestPending = true;
	return this.sendRequest(data, "authentication");
};

SyncClient.prototype.setDefaultServerMessageHandler = function(){
	var self = this;
	self.serverConnection.onmessage = function(event){
		return self.onServerMessage(event.data)
	};
};

SyncClient.prototype.handleServerWarning = function(warning){
	this.showToast(warning.message);
};

SyncClient.prototype.autoReconnect = function(){
	if ( this.disableAutoReconnect || !this.hasReactiveSync() )
		return;
	console.log("Auto reconnection active");
	if ( this.connectInterval )
		return;
	var self = this;
	this.showStatus = false;
	this.connectInterval = setInterval(function(){if (self.isOnline()) self.connect().catch(err=>{});}, 5000);
};

SyncClient.prototype.stopAutoReconnect = function(){
	if ( this.connectInterval ){
		clearInterval(this.connectInterval);
		delete this.connectInterval;
	}
	this.showStatus = true;
};

SyncClient.prototype.connect = function(){
	var self = this;
    return new Promise(function(resolve, reject) {
		if ( !self.isOnline() ){
			self._onOffline();
			return reject("No connection");
		}
		if ( self.isConnected() )
			return resolve(self.serverConnection);
			self.serverConnection = new WebSocket(self.protocol + "://" + self.serverUrl + ":" + self.serverPort);
        self.serverConnection.onopen = function() {
			self._onConnected();
            resolve(self.serverConnection);
        };
        self.serverConnection.onerror = function(err) {
			self._onConnectionError();
            reject("Connection error");
		};
		self.serverConnection.onclose = function(event){
			self._onDisconnected();
			return reject("Connection closed");
		};
		self.setDefaultServerMessageHandler();
    });
};

// TODO:
// Websockets have a buffer size limitation (see ws.setBinaryFragmentation(bytes) on https://www.npmjs.com/package/nodejs-websocket)
// Modifiy changes detection to limit size of changes being sent at once.
SyncClient.prototype.getClientChanges = function(){
	// Get changes on client
	console.log("Getting changes on client...");
	var tables = this.getTablesToSync();
	if ( !tables || (tables.length == 0) ){
		this.showAlert(Translate("Your sync profile has no table to sync ! Synchronization was aborted."));
		return Promise.reject("No tables to sync");
	}
	var changes = {Deletes:null, Upserts:null};
	var self = this;
	return new Promise(function(resolve,reject){
		self.getDeletes(tables)
		.then(res=>{changes.Deletes=res;})
		.then(res=>{return self.getUpserts(tables);})
		.then(res=>{console.log("Done"); changes.Upserts=res; return resolve(changes);})
	});
};

SyncClient.prototype.sendClientChanges = function(changes, reactive){
	// A request is sent, even if there are no client changes, at least to set client->server datetime.
	var self = this;
	console.log("Sending changes to server...");
	if ( reactive )
		changes.reactive = true;
	return self.sendRequest(changes);
};

SyncClient.prototype.requestSchemaUpgrade = function(){
	// Query the server for any schema modification
	var self = this;
	console.log("Requesting schema update from server...");
	var req = {getSchemaUpdate:true};
	return self.sendRequest(req);
};

SyncClient.prototype.requestChanges = function(tables, reactive){
	// tables array is optionnal. If omitted, all tables changes will be requested.
	var self = this;
	if ( tables && Array.isArray(tables) && tables.length  )
		console.log("Requesting changes from server for table(s) " + tables.join(",") + "...");
	else
		console.log("Requesting changes from server (for all tables)...");
	var tablesToSync = this.getTablesToSync();
	var requestTables;
	if ( tables && Array.isArray(tables) && tables.length )
		requestTables = tablesToSync.filter(function(x){return tables.indexOf(x) !== -1;});
	else
		requestTables = tablesToSync;
	var req = {getChanges:requestTables};
	if ( reactive )
		req.reactive = true;
	return self.sendRequest(req);
};

SyncClient.prototype.upgradeDatabase = function(newSchema){
	console.log("upgradeDatabase");
	// The schema has been modified: upgrade client database structures.
	var self = this;
	return new Promise(function(resolve, reject){
		self.connector.upgradeDatabase(newSchema)
		.then(res=>{
			if ( res ){
				self.showToast("Database has been upgraded to version " + newSchema.version);
				self.saveMustUpgrade(false);
				window.setTimeout(function(){resolve(true);}, 3000);		// necessary (only to) display toast for a while before it is cleared by "Sync started" toast.
			}
			else
				resolve(false);
		});
	});
}

SyncClient.prototype.requestSyncProfile = function(){
	var self = this;
	console.log("Requesting user's sync profile from server...");
	var req = {getSyncProfile:true};
	return self.sendRequest(req);
};

SyncClient.prototype.handleServerChanges = function(changes){
	var self = this;
	console.log("Handling changes received from server...");
	var handledTables, keyNames;
	var upserts = {};
	if ( changes.Inserts ){
		for ( var tableName in changes.Inserts ){
			if ( !upserts[tableName] )
				upserts[tableName] = [];
			upserts[tableName] =  upserts[tableName].concat(changes.Inserts[tableName]);
		}
	}
	if ( changes.Updates ){
		for ( var tableName in changes.Updates ){
			if ( !upserts[tableName] )
				upserts[tableName] = [];
			upserts[tableName] =  upserts[tableName].concat(changes.Updates[tableName]);
		}
	}
	return this.getChangesKeyNames(changes)
	.then(res=>{keyNames = res;})
	.then(()=>self.handleDeletes(changes.Deletes, keyNames))
	.then(res=>{handledTables = res;})
	.then(()=>self.handleUpserts(upserts, keyNames))
	.then(res=>{handledTables = handledTables.concat(res); return handledTables;})
	.catch(err=>{console.log("Error during server data reception: " + err); return Promise.reject(err);});
};

// TODO: maybe performances might be improved using parallel upserts into different tables ?
SyncClient.prototype.handleUpserts = function(upserts, keyNames){
	if ( !upserts || !Object.keys(upserts).length )
		return Promise.resolve([]);
	var self = this;
	var tables = [];
	for ( var tableName in upserts ){
		tables.push(tableName);
	}
	var numT = tables.length;
	var t = 0;
	var f = function(t){
		return self.connector.handleUpserts(tables[t], upserts[tables[t]], keyNames[tables[t]])
		.then(()=>{
			if ( t < numT - 1 ){
				t++;
				return f(t);
			}
			return tables;
		})
	}
	return f(0);
};

SyncClient.prototype.handleDeletes = function(deletes, keyNames){
	if ( !deletes || !Object.keys(deletes).length )
		return Promise.resolve([]);
	var self = this;
	var tables = [];
	for ( var tableName in deletes ){
		tables.push(tableName);
	}
	var numT = tables.length;
	var t = 0;
	var f = function(t){
		return self.connector.handleDeletes(tables[t], deletes[tables[t]], keyNames[tables[t]])
		.then(()=>{
			if ( t < numT - 1 ){
				t++;
				return f(t);
			}
			return tables;
		})
	}
	return f(0);
};

SyncClient.prototype.endServerSync = function(handledTables){
	var self = this;
	console.log("Ending server sync...");
	return self.sendRequest({endServerSync:handledTables});
};

SyncClient.prototype.getTablesToSync = function(onlyReactive) {
	// Get the schema of tables + sync modes
	var tablesToSync;
	if ( this.syncProfile && this.syncProfile.length )
		// Sync only tables whose sync profile allow clientSync (client->server sync).
		tablesToSync = this.syncProfile.filter(syncRule=>{
			if ( !Object.values(syncRule) || (Object.values(syncRule).length == 0) )
				return -1;
			return (Object.values(syncRule)[0].clientSync && (!onlyReactive || (Object.values(syncRule)[0].clientSync == 2)) )
		}).map(syncRule=>Object.keys(syncRule)[0]);		// tableName
	else{
		// If the user has no sync profile, the property tablesToSync should be set by the app to indicate which tables to sync.
		if ( !onlyReactive || this.reactiveSync )
			tablesToSync = this.tablesToSync;
	}
	return tablesToSync;
};

SyncClient.prototype.getReactiveSyncTables = function() {
// Get the list of tables whose changes must be sent in realtime to server.
	return this.getTablesToSync(true);
};

SyncClient.prototype.hasReactiveSync = function() {
	return (this.getReactiveSyncTables().length > 0);
};

SyncClient.prototype.getUpserts = function(tables){
	return this.connector.getAllUpserts(tables);
};

SyncClient.prototype.getDeletes = function(tables){
	return this.connector.getAllDeletes(tables);
};

hasChanges = function(changes){
	if ( !changes || ((!changes.Deletes || !Object.keys(changes.Deletes).length) && (!changes.Upserts || !Object.keys(changes.Upserts).length)) ) 
		return false;
	if ( changes.Deletes && Object.keys(changes.Deletes).length )
		return true;
	for ( var u in changes.Upserts ){
		if ( changes.Upserts[u].length > 0 )
			return true;
	}
	return false;
};

SyncClient.prototype.markChangesAsBeingSent = function(changes){
	var tables = this.getChangesTables(changes);
	for ( var t in tables){
		var tableName = tables[t];
		var deletes = changes.Deletes[tableName];
		if ( !deletes )
			deletes = [];
		var upserts = changes.Upserts[tableName];
		if ( !upserts )
			upserts = [];
		var upserts = upserts.map(x=>x[changes.keyNames[tableName]]);
		this.connector.markAsBeingSent(tableName, deletes.concat(upserts.filter(x=>(deletes.indexOf(x) == -1))));
	}
	return Promise.resolve();
};

SyncClient.prototype.resetSentChanges = function(){
	var tableNames = [];
	for ( var tableName in this.changes.Upserts ){
		if ( tableNames.indexOf(tableName) == -1 )
			tableNames.push(tableName);
	}
	for ( var tableName in this.changes.Deletes ){
		if ( tableNames.indexOf(tableName) == -1 )
			tableNames.push(tableName);
	}
	this.allChangesSent = true;
	for ( var tableName in tableNames ){
		if (!this.connector.resetSentChanges(tableNames[tableName]))
			this.allChangesSent = false;
	}
	return Promise.resolve();
};

SyncClient.prototype.resetSendings = function(){
	if ( this.changes ){
		var tableNames = [];
		for ( var tableName in this.changes.Upserts ){
			if ( tableNames.indexOf(tableName) == -1 )
				tableNames.push(tableName);
		}
		for ( var tableName in this.changes.Deletes ){
			if ( tableNames.indexOf(tableName) == -1 )
				tableNames.push(tableName);
		}
		for ( var tableName in tableNames ){
			this.connector.resetSendings(tableNames[tableName]);
		}
	}
	return Promise.resolve();
};

SyncClient.prototype.removeAllToasts = function(){
	var toastContainer = document.querySelector(".toast-container");
	if ( toastContainer )
		toastContainer.remove();
};

SyncClient.prototype.addChangesKeyNames = function(changes){
	return this.getChangesKeyNames(changes)
	.then(res=>{if (res) changes.keyNames = res; return changes;});
};

SyncClient.prototype.getChangesTables = function(changes){
	var tables = [];
	tables = this.addChangesTablesSub(tables, changes.Deletes);
	tables = this.addChangesTablesSub(tables, changes.Upserts);
	tables = this.addChangesTablesSub(tables, changes.Updates);
	tables = this.addChangesTablesSub(tables, changes.Inserts);
	return tables;
};

SyncClient.prototype.addChangesTablesSub = function(tables, changesSub){
	if ( changesSub ){
		for ( var tableName in changesSub ){
			if ( changesSub[tableName] && changesSub[tableName].length && (tables.indexOf(tableName) == -1) )
				tables.push(tableName);
		}
	}
	return tables;
};

SyncClient.prototype.getChangesKeyNames = function(changes){
	var tables = this.getChangesTables(changes);
	return this.getTablesKeyNames(tables);
};

SyncClient.prototype.getTablesKeyNames = function(tables){
	var keyNames = {};
	var numT = tables.length;
	if ( !numT )
		return Promise.resolve(null);
	var t = 0;
	var self = this;
	var f = function(t){
		return self.connector.getKeyName(tables[t])
		.then(res=>{
			keyNames[tables[t]] = res;
			if ( t < numT - 1 ){
				t++;
				return f(t);
			}
			return keyNames;
		})
	}
	return f(0);
};

SyncClient.prototype.fullSync = function(){
	if ( this.clientSyncsPending || this.serverSyncsPending )
		return Promise.resolve();
	var self = this;
	this.syncType = 1;
	// self.sendEvent("syncPending", {reactive:false});
	return self.clientSync()
	.catch(err=>{self._onSyncError(err);})
};

SyncClient.prototype.getAndSendClientChanges = function(reactive){
	if (this.mustUpgrade)
		return Promise.resolve();
	var self = this;
	return self.getClientChanges()
	.then(res=>{self.changes = res;})
	// .then(()=>{if (reactive && self.syncProfile && self.syncProfile.length ) return self.changes; return self.addChangesKeyNames(self.changes);})		// transmit client default keys to the server, in case server schema is not defined yet
	.then(()=>self.addChangesKeyNames(self.changes))		// transmit client default keys to the server, in case server schema is not defined yet
	.then(res=>{self.changes = res;})
	.then(()=>self.markChangesAsBeingSent(self.changes))
	.then(()=>self.sendClientChanges(self.changes, reactive))
};

SyncClient.prototype.clientSync = function(reactive){
	var self = this;
	if ( this.clientSyncsPending )
		return Promise.resolve();
	// Process client sync. If reactive, this is an autonomous process whereas within a full sync, client sync is followed by server sync.
	this.lastSyncFailed = false;
	if ( this.mustUpgrade ){
		this.showMustUpgradeWarning();
		return Promise.resolve();
	}
	return self.authenticate()
	.then(()=>self.connect())
	.then(()=>logMs("CLIENT SYNC STARTED"))
	.then(()=>{ this.clientSyncsPending++; if (reactive) self.syncType = 2; self.sendEvent("syncPending", {reactive:reactive});})
	.then(()=>{if (!reactive) self.requestSchemaUpgrade();})
	.then(()=>{if (reactive) self.getAndSendClientChanges(reactive); else self.requestSyncProfile();})		// in full sync, client changes must be sent AFTER receiving sync profile. In reactive sync, send changes right now.
	.catch(err=>{if (reactive) self._onSyncError(err); else return Promise.reject(err);})
};

SyncClient.prototype.serverSync = function(reactive, tables){
	if ( this.serverSyncsPending )
		return Promise.resolve();
	this.lastSyncFailed = false;
	if ( this.mustUpgrade || this.serverSyncsPending || this.clientSyncsPending )		// database must upgrade or a server sync is already pending
		return Promise.resolve();
	var self = this;
	var handledTables = [];
	return self.authenticate()
	.then(()=>logMs("SERVER SYNC STARTED"))
	.then(()=>self.connect())
	.then(()=>{self.serverSyncsPending++; if (reactive) {self.syncType = 2; self.sendEvent("syncPending", {reactive:reactive});}})
	.then(()=>self.requestChanges(tables, reactive))
	.catch(err=>{if (reactive) self._onSyncError(err); else return Promise.reject(err);})
};

// Changes are detected
SyncClient.prototype.onClientChanges = function(tableName){
	if ( !this.hasReactiveSync() || !this.isConnected() || !this.isAuthenticated() || (this.getTablesToSync().indexOf(tableName) == -1) )
		return;
	else{
		// If table is configured for reactive sync in user's sync profile, send changes in realtime. Otherwise, they will be sent during next full sync.
		var reactiveTables = this.getReactiveSyncTables();
		var self = this;
		if ( reactiveTables.indexOf(tableName) > -1 )
			window.setTimeout(function(){self.clientSync(true);}, 0);
	}
};

SyncClient.prototype.scriptParams = SyncClient.getScriptParams();		// read params passed directly within <script> tag.

// Call constructor if told so (by default)
if ( SyncClient.prototype.scriptParams.autoInit.toString() == "true" ){
	document.addEventListener('DOMContentLoaded', function() {
		if ( (typeof device != "undefined") && device && device.cordova ){
			document.addEventListener('deviceready', function() {
				console.log("Device ready with Cordova");
				SyncClient.initClient(SyncClient.prototype.scriptParams);
			});
		}
		else{
			console.log("Device ready (without Cordova)");
			SyncClient.initClient(SyncClient.prototype.scriptParams);
		}
	});
}
