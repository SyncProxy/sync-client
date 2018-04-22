DBConnectorLocalStorage.prototype = new DBConnector();
DBConnectorLocalStorage.prototype.virtualTableName = "spLocalStorage";

// Extend setItem() function of localStorage to add automatic change-detection capacities when a key/value pair is inserted/modified.
DBConnectorLocalStorage.prototype.monkeyPatch = function(){
	console.log("Patching localStorage functions...");
	var self = this;
	Storage.prototype.setItemSTD = Storage.prototype.setItem;
	Storage.prototype.setItem = function(key, value) {
		var oldValue = this.getItem(key);
		if ( !oldValue )
		{
			if ( (that.dataFilter == null) || that.dataFilter(key) )
				self.markAsInserted([key]);
		}
		else if ( oldValue != value )
		{
			if ( (that.dataFilter == null) || that.dataFilter(key) )
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
			if ( (that.dataFilter == null) || that.dataFilter(key) )
				self.markAsDeleted([key]);
			this.removeItemSTD(key);
		}
	};
	console.log("...patched");
};

////////////////////
// Sync functions //
////////////////////
DBConnectorLocalStorage.prototype.markAsDirty = function(type, arrPKval){	// type: Inserts/Updates/Deletes
	if ( !arrPKval || (arrPKval.length == 0) )
		return;
	var oldItem = localStorage.getItem(DBConnectorLocalStorage.prototype.virtualTableName);
	var newItem;
	if ( oldItem )
	{
		newItem = JSON.parse(oldItem);
		newItem[type] = newItem[type].concat(arrPKval.filter(function(i){
			return (newItem[type].indexOf(i) == -1);
		}));
	}
	else
	{
		newItem = {Inserts:[], Updates:[], Deletes:[]};
		newItem[type] = arrPKval;
	}
	localStorage.setItemSTD(DBConnectorLocalStorage.prototype.virtualTableName, JSON.stringify(newItem));
	if ( DBConnectorLocalStorage.prototype.syncGateway )
		DBConnectorLocalStorage.prototype.syncGateway.setSendModifTimer();
};

DBConnectorLocalStorage.prototype.markAsInserted = function(arrPKval){
	this.markAsDirty("Inserts", arrPKval);
};

DBConnectorLocalStorage.prototype.markAsUpdated = function(arrPKval){
	this.markAsDirty("Updates", arrPKval);
};

DBConnectorLocalStorage.prototype.markAsDeleted = function(arrPKval){
	this.markAsDirty("Deletes", arrPKval);
};

DBConnector.prototype.resetMarkers = function(type) {		// reset UPDATES/INSERTS/DELETES markers
	var oldItem = localStorage.getItem(DBConnectorLocalStorage.prototype.virtualTableName);
	var newItem;
	if ( oldItem )
	{
		newItem = JSON.parse(oldItem);
		newItem[type] = [];
	}
	else
		newItem = {Inserts:[], Updates:[], Deletes:[]};
	localStorage.setItemSTD(DBConnectorLocalStorage.prototype.virtualTableName, JSON.stringify(newItem));
};

function DBConnectorLocalStorage(dbName, dbVersion)
{
	DBConnector.call(this, dbName, dbVersion);
	this.name = "LocalStorage";
	this.monkeyPatch();
}