DBConnectorWebSQL.prototype = new DBConnectorSQLiteBase();
DBConnectorSQLiteBase.plugin = window;		// set base plugin

// DBConnectorWebSQL.prototype.openDB = function(){
	// return DBConnectorSQLiteBase.plugin.openDatabase(this.dbName, this.getDBVersion(), "", DBConnectorSQLiteBase.DEFAULT_DB_SIZE, null);
// };

DBConnectorWebSQL.prototype.openDB = function(){
	return new Promise((resolve,reject)=>{
		resolve(DBConnectorSQLiteBase.plugin.openDatabase(this.dbName, this.getDBVersion(), "", DBConnectorSQLiteBase.DEFAULT_DB_SIZE, null));
	});
};

// Patch SQLite/WebSQL standard function to add automatic changes detection.
DBConnectorWebSQL.prototype.patchOpenDatabase = function(db){
	return db;
};

/////////////////
// Constructor //
/////////////////
function DBConnectorWebSQL(dbName, syncClient)
{
	DBConnectorSQLiteBase.call(this, dbName, syncClient, window);
	this.name = "WebSQL";
	this.monkeyPatch();
}