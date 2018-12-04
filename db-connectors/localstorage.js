// Implements a localStorage connector for SyncProxy client.
// Note: Since localStorage is a simple key/value data store, only 1 table can be synchronized.
// In case a schema exists with several tables, only the first table will be synchronized

DBConnectorLocalStorage.prototype = new DBConnector();
DBConnectorLocalStorage.prototype.ignoredItemPrefix = "syncProxy";
DBConnectorLocalStorage.prototype.defaultTableName = "LocalStorageData";
DBConnectorLocalStorage.prototype.defaultKeyName = "Key";
DBConnectorLocalStorage.prototype.defaultDataProperty = "data";

// Extend setItem() function of localStorage to add automatic change-detection capacities when a key/value pair is inserted/modified.
DBConnectorLocalStorage.prototype.monkeyPatch = function(){
	console.log("Patching localStorage functions...");
	var self = this;
	Storage.prototype.setItemSTD = Storage.prototype.setItem;
	Storage.prototype.setItem = function(key, value) {
		var oldValue = this.getItem(key);
		if ( !oldValue )
		{
			if ( !key.startsWith(self.ignoredItemPrefix) )
				self.markAsInserted([key]);
		}
		else if ( oldValue != value )
		{
			if ( !key.startsWith(self.ignoredItemPrefix) )
				self.markAsUpdated([key]);
		}
		this.setItemSTD(key, value);
	};
	// Extend removeItem() function of localStorage to add automatic change-detection capacities when a key/value pair is deleted.
	Storage.prototype.removeItemSTD = Storage.prototype.removeItem;
	Storage.prototype.removeItem = function(key) {
		var oldValue = this.getItem(key);
		if ( oldValue )
		{
			if ( !key.startsWith(self.ignoredItemPrefix) )
				self.markAsDeleted(self.getDefaultTableName(), [key]);
			this.removeItemSTD(key);
		}
	};
	console.log("...patched");
};

////////////////////
// Sync functions //
////////////////////
DBConnectorLocalStorage.prototype.getDefaultTableName = function(){		// first table of the schema (if any) is assumed to be the table that must be synchronized.
	var schema = this.syncClient.schema;
	if ( schema && schema.Tables && (schema.Tables.length > 0) )
		return schema.Tables[0].Name;
	return this.defaultTableName;
};

DBConnectorLocalStorage.prototype.getKeyName = function(){
	var self = this;
	return DBConnector.prototype.getKeyName.call(this, this.getDefaultTableName())
	.then(res=>{
		if ( res )
			return res;
		return self.defaultKeyName;
	});
};

DBConnectorLocalStorage.prototype.getDataProperty = function(){		// first non-PK column of first table of the schema (if any) is assumed to contain data that must be synchronized.
	var schema = this.syncClient.schema;
	if ( schema && schema.Tables && (schema.Tables.length > 0) && schema.Tables[0].Columns && (schema.Tables[0].Columns.length > 0) ){
		for ( var c in schema.Tables[0].Columns ){
			if ( schema.Tables[0].Columns[c].Name != schema.Tables[0].PK )
				return schema.Tables[0].Columns[c].Name;
		}
	}
	return this.defaultDataProperty;
};

DBConnectorLocalStorage.prototype.getChangesKeyName = function(tableName, ope){		// ope: Deletes/Upserts/Sending
	return this.name + "." + this.dbName + "." + this.getDefaultTableName() + "." + ope;
};

DBConnectorLocalStorage.prototype.markAsInserted = function(arrPKval){
	this.markAsUpserted(this.getDefaultTableName(), arrPKval);
};

DBConnectorLocalStorage.prototype.markAsUpdated = function(arrPKval){
	this.markAsUpserted(this.getDefaultTableName(), arrPKval);
};

/*
DBConnectorLocalStorage.prototype.getMany = function(tableName, arrPKval){
	var dataProperty = this.getDataProperty();
	var self = this;
	return new Promise(function(resolve,reject){
		var result = [];
		for ( var key in arrPKval ){
			var res = {};
			var data = JSON.parse(localStorage.getItem(arrPKval[key]));
			res.Key = arrPKval[key];
			res[dataProperty] = data;
			result.push(res);
		}
		return resolve(result);
	});
};
*/

DBConnectorLocalStorage.prototype.getMany = function(tableName, arrPKval){
	var self = this;
	var dataProperty = this.getDataProperty();
	var keyName;
	return this.getKeyName()
	.then(res=>{
		keyName = res;
		var result = [];
		for ( var key in arrPKval ){
			var res = {};
			var data = JSON.parse(localStorage.getItem(arrPKval[key]));
			res[keyName] = arrPKval[key];
			res[dataProperty] = data;
			result.push(res);
		}
		return result;
	});
};

DBConnectorLocalStorage.prototype.handleUpserts = function(tableName, upserts, keyName){
	var dataProperty = this.getDataProperty();
	for ( var u in upserts )
		// localStorage.setItemSTD(upserts[u][keyName], JSON.stringify(upserts[u].data));
		localStorage.setItemSTD(upserts[u][keyName], JSON.stringify(upserts[u][dataProperty]));
	return Promise.resolve();
};

DBConnectorLocalStorage.prototype.handleDeletes = function(tableName, deletes){
	for ( var d in deletes )
		localStorage.removeItemSTD(deletes[d]);
	return Promise.resolve();
};

function DBConnectorLocalStorage(dbName, dbVersion)
{
	DBConnector.call(this, dbName, dbVersion);
	this.name = "LocalStorage";
	this.monkeyPatch();
}