DBConnectorIndexedDB.prototype = new DBConnector();

DBConnectorIndexedDB.prototype.getIndexedDB = function(){
	return indexedDB || window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB || window.shimIndexedDB;
}

// Patch IndexedDB's standard function to add automatic changes detection.
DBConnectorIndexedDB.prototype.monkeyPatch = function(){
	console.log("Patching IndexedDB functions...");
	var self = this;
	// Patch "add" function of IndexedDB, to automatically mark object as inserted and in needing sync.
	IDBObjectStore.prototype.addSTD = IDBObjectStore.prototype.add;
	IDBObjectStore.prototype.add = function(data,key){
		var that = this;
		// Replace autoIncrement with sync-client generated UID.
		if ( this.autoIncrement )
			data[this.keyPath] = self.newUID();
		var markupKey = key ? key : (this.keyPath ? data[this.keyPath] : null);
		var req;
		if ( key )
			req = this.addSTD(data,key);
		else
			req = this.addSTD(data);
		if ( markupKey )
			self.markAsUpserted(that.name, [markupKey]);
		return req;
	};
	// Patch "put" function of IndexedDB, to automatically mark object as modified and in needing sync.
	IDBObjectStore.prototype.putSTD = IDBObjectStore.prototype.put;
   	IDBObjectStore.prototype.put = function(data,key){
		var that = this;
		// Replace autoIncrement with sync-client generated UID.
		if ( this.autoIncrement )
			data[this.keyPath] = self.newUID();
		var markupKey = key ? key : (this.keyPath ? data[this.keyPath] : null);
		var req;
		if ( key )
			req = this.putSTD(data,key);
		else
			req = this.putSTD(data);
		if ( markupKey )
			self.markAsUpserted(that.name, [markupKey]);
		return req;
	};
	// Patch "delete" function of IndexedDB, to automatically mark object as deleted and in needing sync.
	IDBObjectStore.prototype.deleteSTD = IDBObjectStore.prototype.delete;
	IDBObjectStore.prototype.delete = function(key){
		if ( key instanceof Object )
			key = Object.values(key)[0];
		if ( key )
			self.markAsDeleted(this.name, [key]);
		return this.deleteSTD(key);
	};
	console.log("...patched");
};

DBConnectorIndexedDB.prototype.openDB = function() {
	var self = this;
	return new Promise(function(resolve,reject){
		var request = self.getIndexedDB().openSTD(self.dbName);
		request.onsuccess = function(){
			resolve(request.result);
		};
		request.onerror = function(){
			console.log("openDB error: " + request.error);
			reject("openDB error:" + request.error);
		};
		request.onblocked = function(event){
			console.log("Could not open database " + self.dbName + ": database blocked");
			reject("Could not open database " + self.dbName + ": database blocked");
		};
	});
};

DBConnectorIndexedDB.prototype.openDBAndStore = function(tableName) {
	// Store should be opened this way only for 1-operation transactions. Otherwise, FireFox will throw a TransactionInactiveError for next operations.
	var db, self = this;
	return this.openDB()
	.then(res=>{db = res; return self.getStore(db, tableName);})
	.then(store=>{return {db:db, store:store};})
};

// DBConnectorIndexedDB.prototype.getStore = function(db, tableName) {
	// tx = db.transaction(tableName, "readwrite");
	// var store = tx.objectStore(tableName);
	// return store;
// };

DBConnectorIndexedDB.prototype.getStore = function(db, tableName) {
	try {
		tx = db.transaction(tableName, "readwrite");
	} catch(err){
		return null;
	}
	var store = tx.objectStore(tableName);
	return store;
};

DBConnectorIndexedDB.prototype.newUID = function(){
	return Math.floor((1 + Math.random()) * 0x1000000000);
};

DBConnectorIndexedDB.prototype.upgradeDatabase = function(newSchema){
	console.log("upgradeDatabase");
	var currVersion = this.getDBVersion();
	console.log("currVersion=" + currVersion + " newSchema.version=" + newSchema.version);
	var firstUpgrade;
	if ( !currVersion ){
		firstUpgrade = true;
		currVersion = 1;		// first upgrade: force version to 1, whatever newSchema version
	}
	if ( !firstUpgrade && (newSchema.version <= currVersion) )
		return Promise.resolve(false);		// nothing to do
	var self = this;
	console.log("upgradeDatabase to version=" + newSchema.version);
	var db;
	return new Promise(function(resolve,reject){
		var request = self.getIndexedDB().openSTD(self.dbName, newSchema.version);
		request.onsuccess = function(){
			db = request.result;
			db.close();
			resolve(false);
		};
		request.onupgradeneeded = function(e){
			request.onsuccess = null;
			db = request.result;
			return self.upgradeDatabaseStructure(db, newSchema)
			.then(res=>{self.setDBVersion(newSchema.version); resolve(res);})
			
		};
		request.onerror = function(){
			console.log("upgradeDatabase error: " + request.error);
			reject(false);
		};
		request.onblocked = function(event){
			console.log("Database BLOCKED !!!");
			reject(false);
		};
	});
};

DBConnectorIndexedDB.prototype.upgradeDatabaseStructure = function(db, newSchema){
	var self = this;
	return new Promise(function(resolve,reject){
		if ( newSchema ){
			for ( var t in newSchema.Tables ){
				var table = newSchema.Tables[t];
				if ( !table.Sync && !table.Client )		// Create only tables that must be synched (or explicit client tables), according to schema (and apart from sync profile, which may put some restrictions)
					continue;
				if ( !db.objectStoreNames.contains(table.Name)){
					if ( table.PK )
						db.createObjectStore(table.Name, {keyPath: table.PK});
					else
						db.createObjectStore(table.Name);
				}
				if ( self.syncClient.onUpgradeDatabaseStructure )
					self.syncClient.onUpgradeDatabaseStructure(db, newSchema);
			}
			return resolve(true);
		}
		else
			return resolve(false);
	});
};

DBConnectorIndexedDB.prototype.get = function(store, key) {
	var self = this;
	return new Promise(function(resolve, reject){
		var request = store.get(key);
		request.onsuccess = function(){
			resolve(request.result);
		};
		request.onerror = function(){
			resolve(null);
		};
	});
};

DBConnectorIndexedDB.prototype.getMany = function(tableName, arrKeys){
	if ( !arrKeys || !arrKeys.length )
		return Promise.resolve([]);
	var self = this, arrResult = [], db, store, keyName;
	return this.getKeyName(tableName)
	.then(res=>{
		keyName = res;
	})
	.then(()=>self.openDB())
	.then(res=>{
		db = res;
		// Transaction and store can't be opened using OpenDBAndStore() because Firefox would throw a TransactionInactiveError
		// when execution several operations using the same transaction obtained from a promise.
		tx = db.transaction(tableName, "readwrite");
		var store = tx.objectStore(tableName);
		const promises = [];
		for ( var k in arrKeys ){
			const p = self.get(store, arrKeys[k])
			.then(res=>{
				if (res){
					// If IndexedDB's default key was used (no named key), we must insert its value into data sent to the server
					if ( keyName == "Key" )
						res.Key = arrKeys[k];
					arrResult.push(res);
				}
			})
			promises.push(p); 
		}
		return Promise.all(promises);
	})
	.then(()=>{db.close(); return arrResult;});
};

DBConnectorIndexedDB.prototype.getKeyName = function(tableName){
	var self = this, db, store;
	return this.openDBAndStore(tableName)
	.then(res=>{db = res.db; store = res.store; return (store.keyPath ? store.keyPath : "Key")})
	.then(res=>{db.close(); return res;});
};

DBConnectorIndexedDB.prototype.handleUpserts = function(tableName, upserts, keyName){
	var db, store, self = this;
	return self.openDB()
	.then(res=>{
		db = res;
		// Transaction and store can't be opened using OpenDBAndStore() because Firefox would throw a TransactionInactiveError
		// when execution several operations using the same transaction obtained from a promise.
		tx = db.transaction(tableName, "readwrite");
		var store = tx.objectStore(tableName);
		return self.upsertMany(store, upserts, keyName);
	})
	.then(res=>{db.close(); return res;});
};

DBConnectorIndexedDB.prototype.handleDeletes = function(tableName, deletes){
	var db, store, self = this;
	return self.openDB()
	.then(res=>{
		db = res;
		// Transaction and store can't be opened using OpenDBAndStore() because Firefox would throw a TransactionInactiveError
		// when execution several operations using the same transaction obtained from a promise.
		tx = db.transaction(tableName, "readwrite");
		var store = tx.objectStore(tableName);
		return self.deleteMany(store, deletes);
	})
	.then(res=>{db.close(); return res;});
};

DBConnectorIndexedDB.prototype.upsertMany = function(store, upserts, keyName){
	if ( !upserts || !upserts.length )
		return Promise.resolve();
	const promises = [];
	for ( var u in upserts )
		promises[u] = this.upsertOne(store, upserts[u], keyName);
	return Promise.all(promises)
	.catch(err=>{console.log("Error while upserting objects: " + err); return err;});
};

DBConnectorIndexedDB.prototype.upsertOne = function(store, data, keyName){
	return new Promise(function(resolve,reject){
		// We invoke our copy of standard IndexedDB put() function (putSTD) function because we have monkey patched the original delete() function
		var req;
		if ( store.keyPath)
			req = store.putSTD(data);
		else
			req = store.putSTD(data,data[keyName]);
		req.onsuccess = function(event) {
			return resolve();
		};
		req.onerror = function(err){
			return reject(err);
		};
	});
};

DBConnectorIndexedDB.prototype.deleteMany = function(store, deletes){
	if ( !deletes || !deletes.length )
		return Promise.resolve();
	const promises = [];
	for ( var d in deletes )
		promises[d] = this.deleteOne(store, deletes[d]);
	return Promise.all(promises)
	.catch(err=>{console.log("Error while deleting objects: " + err);});		// delete errors are non blocking
};
DBConnectorIndexedDB.prototype.deleteOne = function(store, key){
	var self = this;
	return new Promise(function(resolve,reject){
		var req = store.deleteSTD(key);		// we invoke our copy of standard IndexedDB delete() function (deleteSTD) function because we have monkey patched the original delete() function
		req.onsuccess = function(event) {
			return resolve();
		};
		req.onerror = function(err){
			return reject(err);
		};
	});
};

/////////////////
// Constructor //
/////////////////
function DBConnectorIndexedDB(dbName, syncClient)
{
	DBConnector.call(this, dbName, syncClient, "IndexedDB");
	this.monkeyPatch();
}