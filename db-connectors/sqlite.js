DBConnectorSQLite.prototype = new DBConnectorSQLiteBase();
DBConnectorSQLiteBase.plugin = window.sqlitePlugin;		// set base plugin

// DBConnectorSQLite.prototype.openDB = function(){
	// return DBConnectorSQLiteBase.plugin.openDatabase({name:this.dbName, location:this.syncClient.dbLocation});
// };

DBConnectorSQLite.prototype.openDB = function(){
	return new Promise((resolve,reject)=>{
		resolve(DBConnectorSQLiteBase.plugin.openDatabase({name:this.dbName, location:this.syncClient.dbLocation}));
	});
};

// Patch SQLite standard function to handle automatic changes detection (Cordova SQLite plugin defines direct executeSql() and sqlBatch() functions on database SQLitePlugin object)
DBConnectorSQLite.prototype.patchOpenDatabase = function(db){
	var self = this;
	if ( typeof db.executeSqlSTD == "undefined" )
		db.executeSqlSTD = db.executeSql;
	if ( db.executeSqlSTD ){
		db.executeSql = function(sql, args, onSuccess, onError){
			var sqlObject;
			return self.parseSql(sql)		// check if sql code contains an INSERT/UPDATE or DELETE operation (otherwise, will return null).
			.then(res=>{
				sqlObject = res;
				if ( sqlObject && sqlObject.pkCol && (sqlObject.ope == "INSERT") ){
					var onSuccessORG = onSuccess;
					onSuccess = function(data){
						// If data have been inserted, first retrieve their rowids, then retrieve and save their PKs into localStorage.
						var rowids = [];
						for ( var r = 0; r < data.rowsAffected; r++ ){
							var rowid = data.insertId - r;
							rowids.push(rowid);
						}
						// Retrieve keys of newly inserted rowids.
						var sqlSelect = "SELECT " + sqlObject.pkCol + " FROM " + sqlObject.table + " WHERE rowid IN (" + rowids.join(",") + ")";
						db.executeSqlSTD(sqlSelect, [], function(data){
							// Save PKs of inserted records into localStorage.
							var pks = [];
							for (var i = 0; i < data.rows.length; i++)
								pks.push(data.rows.item(i)[sqlObject.pkCol]);
							self.markAsUpserted(sqlObject.table, pks);
						});
						if ( onSuccessORG )
							onSuccessORG(data);
					};
				} else if ( sqlObject && sqlObject.pkCol && ((sqlObject.ope == "UPDATE") || (sqlObject.ope == "DELETE")) ){
					// If datas are to be updated or deleted, previously save their PKs into localStorage.
					// Run a similar SELECT query to retrieve rows, in order to mark them as updated/deleted before executing the UPDATE or DELETE.
					var selectQuery = self.convertToSelect(sqlObject.table, sql, args, sqlObject.pkCol);
					db.executeSqlSTD(selectQuery.sql, selectQuery.args,
						function(data){
							// Result of the SELECT: save PK's of records being updated or modified.
							var pks = [];
							for (var i = 0; i < data.rows.length; i++)
								pks.push(data.rows.item(i)[sqlObject.pkCol]);
							if ( sqlObject.ope == "UPDATE" )
								self.markAsUpserted(sqlObject.table, pks);
							else if ( sqlObject.ope == "DELETE" )
								self.markAsDeleted(sqlObject.table, pks);
							db.executeSqlSTD(sql, args, onSuccess, onError);
						},
						function(err){
							console.log(err);
							console.log(selectQuery.sql);
						}
					);
				}
				else
					db.executeSqlSTD(sql, args, onSuccess, onError)
			});
		};
	}
	if ( typeof db.sqlBatchSTD == "undefined" ){
		db.sqlBatchSTD = db.sqlBatch;
		db.sqlBatch = function(arrQueries, onSuccess, onError){
			if ( db.sqlBatchSTD )
				return db.sqlBatchSTD(arrQueries, onSuccess, onError);
		};
	}
	return db;
};

/////////////////
// Constructor //
/////////////////
function DBConnectorSQLite(dbName, dbVersion)
{
	DBConnectorSQLiteBase.call(this, dbName, dbVersion, window.sqlitePlugin);
	this.name = "SQLite";
	this.monkeyPatch();
}