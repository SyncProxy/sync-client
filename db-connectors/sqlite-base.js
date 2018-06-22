DBConnectorSQLiteBase.prototype = new DBConnector();
DBConnectorSQLiteBase.DEFAULT_DB_SIZE = 20000000;

// The openDatabase() parameters are different between WebSQL and SQLite implementations
DBConnectorSQLiteBase.prototype.openDB = function(){
};

// Patch SQLite/WebSQL standard function to handle automatic changes detection.
DBConnectorSQLiteBase.prototype.patchExecuteSql = function(db, tx){
	var self = this;
	if ( typeof db.executeSqlSTD == "undefined" )
		tx.executeSqlSTD = tx.executeSql;		// save standard executeSql() function.
	tx.executeSql = function(sql, args, onSuccess, onError){
		var sqlObject;
		return self.parseSql(sql)		// check if sql code contains an INSERT/UPDATE or DELETE operation (otherwise, will return null).
		.then(res=>{
			sqlObject = res;
			if ( sqlObject && sqlObject.pkCol && ((sqlObject.ope == "INSERT INTO") || (sqlObject.ope == "INSERT OR REPLACE INTO")) ){
				var onSuccessORG = onSuccess;
				onSuccess = function(tx, data){
					// If datas have been inserted, first retrieve their rowids, then retrieve and save their PKs into localStorage.
					var rowids = [];
					for ( var r = 0; r < data.rowsAffected; r++ ){
						var rowid = data.insertId - r;
						rowids.push(rowid);
					}
					// Retrieve PKs which correspond to newly inserted rowids.
					var sqlSelect = "SELECT " + sqlObject.pkCol + " FROM " + sqlObject.table + " WHERE rowid IN (" + rowids.join(",") + ")";
					db.transactionSTD(function(tx) {
						tx.executeSql(sqlSelect, [], function (tx, data) {
							var pks = [];
							for (var i = 0; i < data.rows.length; i++){
								pks.push(data.rows.item(i)[sqlObject.pkCol]);
							}
							// Save PKs of inserted records into localStorage.
							self.markAsUpserted(sqlObject.table, pks);
						});
					});
					if ( onSuccessORG )
						onSuccessORG(tx, data);
				};
			}
			if ( sqlObject && sqlObject.pkCol && ((sqlObject.ope == "UPDATE") || (sqlObject.ope == "DELETE FROM")) ){
				// If datas are to be updated or deleted, previously save their PKs into localStorage.
				// Run a similar SELECT query to retrieve rows, in order to mark them as updated/deleted before executing the UPDATE or DELETE.
				var sqlSelect = self.convertSqlToSelect(sql, sqlObject.table);
				db.transactionSTD(function(tx) {
					tx.executeSql(sqlSelect, args, function (tx, data) {		// first, execute the SELECT
						// Result of the SELECT: save PK's of records being updated or modified.
						var pks = [];
						for (var i = 0; i < data.rows.length; i++){
							pks.push(data.rows.item(i)[sqlObject.pkCol]);
						}
						if ( sqlObject.ope == "UPDATE" )
							self.markAsUpserted(sqlObject.table, pks);
						else if ( sqlObject.ope == "DELETE FROM" )
							self.markAsDeleted(sqlObject.table, pks);
					});
					tx.executeSql(sql, args, onSuccess, onError);		// finally execute the UPDATE or DELETE
				},
				onTxError, onTxSuccess);
			}
			else
				tx.executeSqlSTD(sql, args, onSuccess, onError);
		})
		.catch(err=>console.log(err));
	};
};

// Patch SQLite/WebSQL standard function to handle automatic changes detection.
DBConnectorSQLiteBase.prototype.monkeyPatch = function(){
	var self = this;
	console.log("Patching " + this.name + " functions...");
	// Extend DBConnectorSQLiteBase.plugin.openDatabase() to implement change detection on INSERTs/UPDATEs/DELETEs queries.
	if ( typeof DBConnectorSQLiteBase.plugin.openDatabaseSTD == "undefined"){
		DBConnectorSQLiteBase.plugin.openDatabaseSTD = DBConnectorSQLiteBase.plugin.openDatabase;		// save standard DBConnectorSQLiteBase.plugin.openDatabase() function.
		DBConnectorSQLiteBase.plugin.openDatabase = function(param1, param2, param3, param4, param5){
			var db = DBConnectorSQLiteBase.plugin.openDatabaseSTD(param1, param2, param3, param4, param5);

			if ( typeof db.transactionSTD == "undefined" ){
				// db.transactionSTD = db.__proto__.transaction;		// save standard transaction() function.
				db.transactionSTD = db.transaction;		// save standard transaction() function.
				db.transaction = function(func, onTxError, onTxSuccess){
					var funcORG = func;		// save user function.
					func = function(tx){		// extend user func to intercept INSERT/UPDATE/DELETE queries and handle changes.
						self.patchExecuteSql(db, tx);
						return funcORG(tx);
					};
					return db.transactionSTD(func, onTxError, onTxSuccess);
				};
			}
			// Add some extra patches on the db object
			db = self.patchOpenDatabase(db);
			return db;
		}
		console.log("...patched");
	}
};

/////////////////////////////////
// Schema extraction functions //
/////////////////////////////////
DBConnectorSQLiteBase.prototype.extractTableName = function(sql) {
	s = sql.trim();
	if ( s.indexOf("`") != -1 )
	{
		s = s.substr(1);
		s = s.substr(0, s.indexOf("`"));
	}
	else
	{
		var i1 = s.indexOf(" ");
		var i2 = s.indexOf("(");
		if ( i1 == -1 )
			i1 = 1000000;
		if ( i2 == -1)
			i2 = 1000000;
		i = Math.min(i1, Math.min(i2,s.length));
		s = s.substr(0, i);
	}
	return s;
};

DBConnectorSQLiteBase.prototype.getKeyName = function(tableName){
	if ( !this.syncClient.schema )
		this.syncClient.loadSchema();
	var schema = this.syncClient.schema;
	var result = null;
	if ( schema ){
		for ( var t in schema.Tables ){
			if ( schema.Tables[t].Name == tableName ){
				result = schema.Tables[t].PK;
				break;
			}
		}
	}
	if ( result )
		return Promise.resolve(result);
	if ( this.getKeyNameFromDatabase )
		return this.getKeyNameFromDatabase(tableName)	// search PK from database
	else
		return Promise.resolve(null);
};

DBConnectorSQLiteBase.prototype.getSyncColumns = function(tableName){
	var self = this;
	return new Promise(function(resolve,reject){
		if ( !self.syncClient.schema )
			self.syncClient.loadSchema();
		var schema = self.syncClient.schema;
		if ( schema && schema.Tables ){
			for ( var t in schema.Tables ){
				if ( schema.Tables[t].Name == tableName ){
					var syncCols = [];
					var cols = schema.Tables[t].Columns;
					for ( var c in cols ){
						if ( cols[c].Sync )
							syncCols.push(cols[c].Name);
					}
					return resolve(syncCols);
				}
			}
		}
		return resolve([]);
	})
	.then(res=>{
		if ( res.length || !self.getTableInfoFromDatabase )
			return res;
		return self.getTableInfoFromDatabase(tableName);		// get columns definition from database and assume they are all synched
	})
	.then(res=>res.map(c=>c.name))
	.catch(err=>{console.log(err); myalert(err);});
};

// Extract the type of operation (INSERT/UPDATE/DELETE) and the destination table. Also return table's PK column.
DBConnectorSQLiteBase.prototype.parseSql = function(sql){
	var result = {};
	var i = -1;
	var ops = ["INSERT INTO", "INSERT OR REPLACE INTO", "UPDATE", "DELETE FROM"];
	for ( var op in ops )
	{
		var ope = ops[op];
		if ( sql.trim().toUpperCase().indexOf(ope) == 0 )
		{
			result.ope = ope;
			i = sql.toUpperCase().indexOf(ope) + ope.length;
		}
	}
	if ( i == -1 )
		return Promise.resolve(null);
	result.table = this.extractTableName(sql.substr(i));
	return this.getKeyName(result.table)
	.then(res=>{
		result.pkCol = res;
		return result;
	});
};

DBConnectorSQLiteBase.prototype.convertSqlToSelect = function(sql, tableName){
	// var s = "SELECT DISTINCT * FROM `" + tableName + "`";
	var s = "SELECT * FROM `" + tableName + "`";
	var posW = sql.toUpperCase().indexOf("WHERE");
	if ( posW > 0 )
		s += " " + sql.substr(posW);
	return s;
}

DBConnectorSQLiteBase.prototype.getDBVersion = function(){
	var v = this.getItem(this.dbName + ".dbVersion");
	if ( v )
		return v;
	return "1.0";
};

//////////////////////
// Schema functions //
//////////////////////
DBConnectorSQLiteBase.prototype.getColDef = function(table, colName){
	for ( var c in table.Columns ){
		var col = table.Columns[c];
		if ( col.Name == colName ){
			var primaryKey = "", size = col.Size, nullable = col.Nullable, defaultVal = col.Default;
			if ( col.Name == table.PK )
				primaryKey = " PRIMARY KEY";
			if ( (nullable === false) && (defaultVal !== null) )
				nullable = " NOT NULL";
			else
				nullable = "";
			if ( size > 0 )
				size = "(" + size + ")";
			else
				size = "";
			if ( defaultVal !== null )
				defaultVal = " DEFAULT " + defaultVal;
			else
				defaultVal = "";
			return col.Type + primaryKey + size + nullable + defaultVal;
		}
	}
	return null;
};

DBConnectorSQLiteBase.prototype.upgradeDatabase = function(schema){
	console.log("upgradeDatabase");
	var currVersion = this.getDBVersion();
	console.log("currVersion=" + currVersion + " newSchema.version=" + schema.version);
	var firstUpgrade;
	if ( !currVersion ){
		firstUpgrade = true;
		currVersion = 1;		// first upgrade: force version to 1, whatever newSchema version
	}
	if ( !firstUpgrade && (schema.version <= currVersion) )
		return Promise.resolve(false);		// nothing to do
	var self = this;
	console.log("upgradeDatabase to version=" + schema.version);
	
	return new Promise(function(resolve,reject){
		// var db = DBConnectorSQLiteBase.plugin.openDatabase(self.dbName, self.getDBVersion(), "", DEFAULT_DB_SIZE);
		var db = self.openDB();
		db.transactionSTD(function(tx){
			// Create tables of the new schema (when not exist)
			for ( var t in schema.Tables ){
				const table = schema.Tables[t];
				if ( !table.PK ){
					console.log("Table " + table.Name + " was not created because it has not primary key");
					continue;
				}
				var sql = "CREATE TABLE IF NOT EXISTS `" + table.Name + "` (`" + table.PK + "` " + self.getColDef(table, table.PK) + ")";
				tx.executeSql(sql, [],
					function(tx, result){
						// Create columns
						for ( var c in table.Columns ){
							const col = table.Columns[c];
							if ( col.Name == table.PK )
								continue;
							var sqlAddCol = "ALTER TABLE `" + table.Name + "` ADD `" + col.Name + "` " + self.getColDef(table, col.Name);
							console.log(sqlAddCol);
							tx.executeSql(sqlAddCol, [], null, function(tx,err){
								console.log("Column " + table.Name + "." + col.Name + " was not added (maybe it already exists ?)");
								console.dir(err);
								// reject(err);
							});
						}
					},
					function(tx, err){
						console.log("Error creating table " + table.Name);
						console.dir(err);
						reject(err);
					}
				);
			}
		}, 
		function(err){
			console.log("upgradeDatabase error:");
			console.dir(err);
			return reject(err);
		},
		function(){
			return resolve();
		});
	});
};

/////////////////////////
// Sync data to server //
/////////////////////////
/*
DBConnectorSQLiteBase.prototype.getMany = function(tableName, arrKeys){
	if ( !arrKeys || !arrKeys.length )
		return Promise.resolve([]);
	var self = this, keyName;
	return 	this.getKeyName(tableName, true)
	.then(res=>{
		keyName = res;
		var db = self.openDB();
		return new Promise(function(resolve,reject){
			db.transactionSTD(function(tx){
				var syncCols = self.getSyncColumns(tableName).join(",");
				if ( syncCols == "" )
					syncCols = "*";
				var sql = "SELECT " + syncCols + " FROM " + tableName + " WHERE " + keyName + " IN (" + arrKeys.join(",") + ")";
				myalert(sql);
				tx.executeSql(sql, [],
					function(tx, data){
						var result = [];
						for ( var r = 0; r < data.rows.length; r++ )
							result.push(data.rows.item(r))
						return resolve(result);
					},
					function(tx, err){
						reject(err);
					}
				);
			});
		})
		.catch(err=>{console.log(err); myalert(err);});
		
	})
	.catch(err=>{console.log(err); myalert(err);});
};
*/
DBConnectorSQLiteBase.prototype.getMany = function(tableName, arrKeys){
	if ( !arrKeys || !arrKeys.length )
		return Promise.resolve([]);
	var self = this, keyName, syncCols;
	return 	this.getKeyName(tableName, true)
	.then(res=>{keyName = res; return self.getSyncColumns(tableName);})
	.then(res=>{
		syncCols = res.join(",");
		if ( syncCols == "" )
			syncCols = "*";
		return new Promise(function(resolve,reject){
			var db = self.openDB();
			db.transactionSTD(function(tx){
				var sql = "SELECT " + syncCols + " FROM " + tableName + " WHERE " + keyName + " IN (" + arrKeys.join(",") + ")";
				myalert(sql);
				tx.executeSql(sql, [],
					function(tx, data){
						var result = [];
						for ( var r = 0; r < data.rows.length; r++ )
							result.push(data.rows.item(r))
						return resolve(result);
					},
					function(tx, err){
						myalert(err);
						console.log(err);
						reject(err);
					}
				);
			});
		})
	})
	.catch(err=>{console.log(err); myalert(err);});
};


///////////////////////////
// Sync data from server //
///////////////////////////
DBConnectorSQLiteBase.prototype.handleUpserts = function(tableName, upserts, keyName){
	// Try to UPDATE each received row to local DB, if not exists (rowsAffected = 0) then INSERT new row
	// Note: we don't use INSERT OR REPLACE INTO query, because it destroys existing rows and create new ones, resulting in new ROWID and PK in case of AUTOINCREMENT PK
	var self = this, cols;
	return self.getSyncColumns(tableName)
	.then(res=>{
		cols = res;
		return new Promise(function(resolve,reject){
			var db = self.openDB();
			var numInserts = 0;
			var sqlUpdate = "UPDATE `" + tableName + "` SET " + cols.filter(c=> c != keyName).map(c=>c + "=?").join(",") + " WHERE `" + keyName + "`=?";		// key value can't be updated
			var sqlInsert = "INSERT INTO `" + tableName + "` (" + cols.join(",") + ") VALUES (" + cols.map(c=>"?").join(",") + ")";
			myalert(sqlUpdate);
			myalert(sqlInsert);
			db.transactionSTD(
				function(tx){
					for ( var u in upserts ){
						// Reorder current row's properties (JSON) to match cols order.
						var currRow = upserts[u];
						const dataToUpdate = [];
						const dataToInsert = [];
						for ( c in cols ){
							if ( cols[c] != keyName )		// key value can't be updated
								dataToUpdate.push(currRow[cols[c]]);
							dataToInsert.push(currRow[cols[c]]);
						}
						myalert("dataToInsert: " + dataToInsert.join(","));
						tx.executeSql(sqlUpdate, dataToUpdate.concat([currRow[keyName]]), function(tx, result){
							// If current row was not updated, insert it
							if ( !result.rowsAffected ){
								tx.executeSql(sqlInsert, dataToInsert, function(rx,result){
									numInserts += result.rowsAffected;
								},
								function(tx, err){
									console.log(err);
									reject(err);
								});
							}
						},
						function(tx, err){
							console.log(err);
							reject(err);
						});
					}
				},
				function(err){
					console.log(err);
					reject(err);
				},
				function(){
					myalert("numInserts: " + numInserts);
					return resolve(numInserts);
				},
			);
		});
	})
	.catch(err=>{console.log(err); myalert(err);});
};

DBConnectorSQLiteBase.prototype.handleDeletes = function(tableName, deletes, keyName){
	var self = this;
	return new Promise(function(resolve,reject){
		// var db = DBConnectorSQLiteBase.plugin.openDatabase(self.dbName, self.getDBVersion(), "", DEFAULT_DB_SIZE);
		var db = self.openDB();
		db.transactionSTD(function(tx){
			var sql = "DELETE FROM `" + tableName + "` WHERE " + keyName + " IN (" + deletes.map(d=>"?").join(",") + ")";
			tx.executeSql(sql, deletes,
				function(tx, data){
					return resolve();
				},
				function(tx, err){
					console.log(err);
					reject(err);
				}
			);
		});
	});
};

/////////////////
// Constructor //
/////////////////
function DBConnectorSQLiteBase(dbName, syncClient)
{
	DBConnector.call(this, dbName, syncClient);
	this.name = "SQLiteBase";
}