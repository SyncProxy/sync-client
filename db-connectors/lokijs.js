// Implements a LokiJS connector
// Collections are dumped to/from IndexedDB for data persistence
DBConnectorLokiJS.prototype = new DBConnector();

DBConnectorLokiJS.prototype.getKeyName = function(tableName, synchronous){
	// Get key name synchronously
	return DBConnector.prototype.getKeyName.call(this, tableName, synchronous);
};

/* DBConnectorLokiJS.prototype.getManySynchronous = function(tableName, arrPKval){
	const self = this, collection = this.db.getCollection(tableName);
	var keyName = this.getKeyName(tableName, true);
	const res = [];
	for ( var k in arrPKval ){
		const keyVal = arrPKval[k];
		var obj = collection.by(keyName, keyVal);
		if ( obj )
			res.push(obj);
	}
	return res;
};

DBConnectorLokiJS.prototype.getMany = function(tableName, arrPKval, synchronous){
	const self = this;
	if ( synchronous )
		return this.getManySynchronous(tableName, arrPKval);
	else
		return new Promise((resolve, reject)=>{
			resolve(self.getManySynchronous(tableName, arrPKval));
		});
}; */

DBConnectorLokiJS.prototype.getMany = function(tableName, arrLokiKeys){
	// We use rows meta property $loki to retrieve rows contents
	const self = this;
	return new Promise((resolve, reject)=>{
		const res = [];
		for ( var k in arrLokiKeys ){
			const lokiKey = arrLokiKeys[k];
			var obj = collection.get(lokiKey);
			if ( obj )
				res.push(obj);
		}
		resolve(res);
	});
};

DBConnectorLokiJS.prototype.getDeletesKeys = function(tableName) {
	const keyName = this.getKeyName(tableName, true);
	if ( !this.db.getCollection(tableName) || !this.db.getCollection(tableName).changes )
		return [];
	return this.db.getCollection(tableName).changes
	.filter(x=>(x.name == tableName) && (x.operation == "R"))		// "R" for LokiJS remove
	.map(x=>x.obj[keyName]);
};

DBConnectorLokiJS.prototype.getUpserts = function(tableName) {
	const collection = this.db.getCollection(tableName);
	if ( !collection || !collection.changes )
		return Promise.resolve([]);
	return new Promise((resolve,reject)=>{
		var lokiKeys = collection.changes
		.filter(x=>(x.name == tableName) && ((x.operation == "U") || (x.operation == "I")))
		// .map(x=>{var y = {}; Object.assign(y, x.obj); delete y.meta; delete y.$loki; return y})
		.map(x=>x.obj.$loki);
		// We have to query data after querying changes because LokiJS changes only show changed data, except new fields
		resolve(
			collection.find({$loki:{$in:lokiKeys}})
			.map(x=>{const y = {}; Object.assign(y, x); delete y.meta; delete y.$loki; return y;})
		);
	});
};

DBConnectorLokiJS.prototype.onClientChanges = function(collection){
	// LokiJS handles change detection by itself: we just notify sync client that some changes occurred
	if ( this.syncClient )
		this.syncClient.onClientChanges(collection.name);
};

DBConnectorLokiJS.prototype.setChangesEvents = function(collection){
	// Set onUpdate, onInsert and onRemove events to trigger reactive sync to server
	if ( !collection || collection.hasSetChangesEvents )		// if already patched, abort
		return;
	const self = this;
	collection.on("update", function(){
		if ( !this.disableChangesEvents )
			self.onClientChanges(collection);
	});
	collection.on("insert", function(){
		if ( !this.disableChangesEvents )
			self.onClientChanges(collection);
	});
	collection.on("delete", function(){
		if ( !this.disableChangesEvents )
			self.onClientChanges(collection);
	});
};

DBConnectorLokiJS.prototype.handleUpserts = function(tableName, upserts, keyName){
	const collection = this.db.getCollection(tableName);
	if ( !collection )
		return Promise.reject("Collection " + tableName + " not found");
	// Disable LokiJS changes detection and changes events while saving server upserts.
	const changesApiEnabled = !collection.disableChangesApi;		// save setting
	collection.setChangesApi(false);
	collection.disableChangesEvents = true;
	for ( var u in upserts ){
		const upsert = upserts[u];
		if ( row = collection.by(keyName, upsert[keyName]) ){
			Object.assign(row, upsert);
			collection.update(row);
		}
		else
			collection.insert(upsert);
	}
	// Reset previous LokiJS changes detection setting and changes events
	collection.setChangesApi(changesApiEnabled);
	if ( collection.disableChangesEvents )
		delete collection.disableChangesEvents;
	return Promise.resolve();
};

DBConnectorLokiJS.prototype.handleDeletes = function(tableName, deletes, keyName){
	const collection = this.db.getCollection(tableName);
	if ( !collection )
		return Promise.reject("Collection " + tableName + " not found");
	// Disable LokiJS changes detection and changes events while saving server deletes.
	const changesApiEnabled = !collection.disableChangesApi;		// save setting
	collection.setChangesApi(false);
	collection.disableChangesEvents = true;
	const findCriteria = {};
	findCriteria[keyName] = {$in:deletes};
	res = collection.find(findCriteria);
	if ( res )
		collection.remove(res);
	// Reset previous LokiJS changes detection setting and changes events
	collection.setChangesApi(changesApiEnabled);
	if ( collection.disableChangesEvents )
		delete collection.disableChangesEvents;
	return Promise.resolve();
};

DBConnectorLokiJS.prototype.initDatabase = function(){
	logMs("Init LokiJS database");
	const schema = SyncClient.defaultClient.schema;
	const self = SyncClient.defaultClient.connector;
	const db = self.db;
	if ( !schema ){
		logMs("No schema yet: init cancelled");
		return;
	}
	for ( var t in schema.Tables ){
		const table = schema.Tables[t];
		if ( !db.getCollection(table.Name) ){
			db.addCollection(table.Name,  {unique: table.PK} );
		}
		db.getCollection(table.Name).setChangesApi(true);		// By default enable LokiJS built-in changes detection
		if ( !db.getCollection(table.Name).hasSetChangesEvents )
			self.setChangesEvents(db.getCollection(table.Name));
	}
	DBConnectorLokiJS.prototype.loadLokiChanges(self);		// load changes from localStorage (changes are not persisted by LokiJS saveDatabase() function)
	return Promise.resolve();
};

DBConnectorLokiJS.prototype.onClientChangesReceived = function(){
	SyncClient.defaultClient.connector.clientChangesReceived = true;
};

DBConnectorLokiJS.prototype.getChangesKeyName = function(db, collection){		// ope: Deletes/Upserts/Sending
	return "LokiJS." + db.filename + "." + collection.name + ".changes";
};

DBConnectorLokiJS.prototype.saveLokiChanges = function(connector){
	logMs("saveLokiChanges");
	const db = connector.db;
	for ( var c in db.collections ){
		const collection = db.collections[c];
		const itemName = DBConnectorLokiJS.prototype.getChangesKeyName(db, collection);
		connector.setItem(itemName, JSON.stringify(collection.changes));
	}
};

DBConnectorLokiJS.prototype.loadLokiChanges = function(connector){
	logMs("loadLokiChanges");
	const db = connector.db;
	for ( var c in db.collections ){
		const collection = db.collections[c];
		if ( collection.changes.length )
			continue;
		const itemName = DBConnectorLokiJS.prototype.getChangesKeyName(db, collection);
		const changesItem = connector.getItem(itemName);
		var jsonChanges;
		if ( changesItem ){
			jsonChanges = JSON.parse(changesItem);
			collection.changes = jsonChanges.concat(collection.changes);
		}
	}
};

DBConnectorLokiJS.prototype.onSyncEnd = function(){
	var db = this.db;
	if ( !db )
		db = SyncClient.defaultClient.connector.db;
	// Reset client changes after we make sure they were handled by server
	if ( SyncClient.defaultClient.connector.clientChangesReceived ){
		delete SyncClient.defaultClient.connector.clientChangesReceived;
		db.clearChanges();
	}
	// setTimeout(function(){
		// logMs("Saving LokiJS database");
		// db.saveDatabase();
	// }, 0);
};

function DBConnectorLokiJS(dbName, dbVersion)
{
	DBConnector.call(this, dbName, dbVersion, "LokiJS");
	const self = this;
	includeFile("libs/lokijs.min.js")
	.then(()=>includeFile("libs/loki-indexed-adapter.min.js"))
	.then(()=>{
		window.addEventListener("syncEnd", self.onSyncEnd);
		window.addEventListener("clientChangesReceived", self.onClientChangesReceived);
		window.addEventListener("clientReady", self.loadAllCollections);
		var idbAdapter = new LokiIndexedAdapter();
		self.db = new loki(dbName, { 
			adapter: idbAdapter,
			autoload: true,
			autoloadCallback : self.initDatabase,
			autosave: true,
			autosaveInterval: 5000,
			autosaveCallback: function(){logMs("autosaveCallBack"); self.saveLokiChanges(self);}
		});
	});
}