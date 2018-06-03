DBConnectorLocalStorage.prototype = new DBConnector();

DBConnectorLocalStorage.prototype.ignoredItemPrefix = "syncProxy";
DBConnectorLocalStorage.prototype.virtualTableName = "LocalStorageData";

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
				self.markAsDeleted(self.virtualTableName, [key]);
			this.removeItemSTD(key);
		}
	};
	console.log("...patched");
};

////////////////////
// Sync functions //
////////////////////
DBConnectorLocalStorage.prototype.getKeyName = function(tableName){
	return Promise.resolve("Key");
};

DBConnectorLocalStorage.prototype.markAsInserted = function(arrPKval){
	this.markAsUpserted(this.virtualTableName, arrPKval);
};

DBConnectorLocalStorage.prototype.markAsUpdated = function(arrPKval){
	this.markAsUpserted(this.virtualTableName, arrPKval);
};

DBConnectorLocalStorage.prototype.getMany = function(tableName, arrPKval){
	return new Promise(function(resolve,reject){
		var result = [];
		for ( var key in arrPKval ){
			var res = {};
			res.Key = arrPKval[key]
			res.data = JSON.parse(localStorage.getItem(arrPKval[key]));
			result.push(res);
		}
		return resolve(result);
	});
};

DBConnectorLocalStorage.prototype.handleUpserts = function(tableName, upserts, keyName){
	for ( var u in upserts )
		localStorage.setItemSTD(upserts[u][keyName], JSON.stringify(upserts[u].data));
	return Promise.resolve();
};

DBConnectorLocalStorage.prototype.handleDeletes = function(tableName, deletes){
	for ( var d in deletes )
		this.removeItemSTD(deletes[d]);
	return Promise.resolve();
};

function DBConnectorLocalStorage(dbName, dbVersion)
{
	DBConnector.call(this, dbName, dbVersion);
	this.name = "LocalStorage";
	this.monkeyPatch();
}