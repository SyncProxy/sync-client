DBConnectorSQLiteBase.prototype = new DBConnectorSQLBase();
DBConnectorSQLiteBase.DEFAULT_DB_SIZE = 20000000;

includeFile("libs/sqliteparser.js");

// The openDatabase() parameters are different between WebSQL and SQLite implementations
// DBConnectorSQLiteBase.prototype.openDB = function(){
// };

// Patch SQLite/WebSQL standard function to handle automatic changes detection.
DBConnectorSQLiteBase.prototype.patchExecuteSql = function(db, tx){
	var self = this;
	if ( typeof tx.executeSqlSTD == "undefined" )
		tx.executeSqlSTD = tx.executeSql;		// save standard executeSql() function.
	tx.executeSql = function(sql, args, onSuccess, onError){
		var sqlObject;
		return self.parseSql(sql)		// check if sql code contains an INSERT/UPDATE or DELETE operation (otherwise, will return null).
		.then(res=>{
			sqlObject = res;
			if ( sqlObject && sqlObject.pkCol && (sqlObject.ope == "INSERT") ){
				var onSuccessORG = onSuccess;
				onSuccess = function(tx, data){
					// If data have been inserted, first retrieve their rowids, then retrieve and save their PKs into localStorage.
					var rowids = [];
					for ( var r = 0; r < data.rowsAffected; r++ ){
						var rowid = data.insertId - r;
						rowids.push(rowid);
					}
					// Retrieve keys of newly inserted rowids.
					var sqlSelect = "SELECT " + sqlObject.pkCol + " FROM " + sqlObject.table + " WHERE rowid IN (" + rowids.join(",") + ")";
					db.transactionSTD(function(tx) {
						tx.executeSql(sqlSelect, [], function (tx, data) {
							// Save PKs of inserted records into localStorage.
							var pks = [];
							for (var i = 0; i < data.rows.length; i++)
								pks.push(data.rows.item(i)[sqlObject.pkCol]);
							self.markAsUpserted(sqlObject.table, pks);
						});
					});
					if ( onSuccessORG )
						onSuccessORG(tx, data);
				};
			}
			if ( sqlObject && sqlObject.pkCol && ((sqlObject.ope == "UPDATE") || (sqlObject.ope == "DELETE")) ){
				// If datas are to be updated or deleted, previously save their PKs into localStorage.
				// Run a similar SELECT query to retrieve rows, in order to mark them as updated/deleted before executing the UPDATE or DELETE.
				var selectQuery = self.convertToSelect(sqlObject.table, sql, args, sqlObject.pkCol);
				db.transactionSTD(function(tx) {
					tx.executeSql(selectQuery.sql, selectQuery.args, function (tx, data){		// first, execute the SELECT
						// Result of the SELECT: save PK's of records being updated or modified.
						var pks = [];
						for (var i = 0; i < data.rows.length; i++)
							pks.push(data.rows.item(i)[sqlObject.pkCol]);
						if ( sqlObject.ope == "UPDATE" )
							self.markAsUpserted(sqlObject.table, pks);
						else if ( sqlObject.ope == "DELETE" )
							self.markAsDeleted(sqlObject.table, pks);
						tx.executeSql(sql, args, onSuccess, onError);		// finally execute the UPDATE or DELETE
					},
					function(tx, err){
						console.log(err);
						console.log(selectQuery.sql);
					});
				});
			}
			else
				tx.executeSqlSTD(sql, args, onSuccess, onError);
		});
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

///////////////////////
// DB base functions //
///////////////////////
DBConnectorSQLiteBase.prototype.executeTransaction = function(transFunc){
	var self = this;
	return self.openDB()
	.then(db=>{
		return new Promise((resolve,reject)=>{
			db.transactionSTD(transFunc,
				function(tx, err){
					console.log(err);
					return reject(err);
				},
				function(tx, res){
					return resolve(res);
				}
			);
		});
	})
	.catch(err=>{console.log(err); return reject(err);});
};

DBConnectorSQLiteBase.prototype.executeSQL = function(tx, sql, params, ignoreError){
	return new Promise((resolve,reject)=>{
		tx.executeSql(sql, params,
			function(tx, res){
				return resolve(res);
			},
			function(tx, err){
				if (!ignoreError)
					console.log(err);
				return reject(err);
			}
		);
	});
};

/////////////////////////////////
// Schema extraction functions //
/////////////////////////////////
// Get table info directly from local db strucure (if no tableName is given, get all tables)
// DBConnectorSQLiteBase.prototype.getTableInfoFromDatabase = function(tableName){
	// var self = this;
	// return self.openDB()
	// .then(db=>{
		// return new Promise((resolve,reject)=>{
			// self.executeTransaction(function(tx){
				// var sql = "SELECT sql FROM sqlite_master WHERE type='table'";
				// if ( tableName )
					// sql += " AND name LIKE '" + tableName + "'";
				// return self.executeSQL(tx, sql, [])
				// .then(data=>{
					// var sqlCreates = [];
					// for ( var r = 0; r < data.rows.length; r++ )
						// sqlCreates.push(data.rows.item(r).sql);				// sql is provided by SQLite as: CREATE TABLE...
					// return resolve(sqlCreates);
				// });
			// });
		// });
	// })
	// .catch(err=>console.log(err));	
// };

// // Retrieve key column directly from local db strucure (if no tableName is given, get all tables)
// DBConnectorSQLiteBase.prototype.getKeyNamesFromDatabase = function(tableName){
	// var self = this;
	// return this.getTableInfoFromDatabase(tableName)
	// .then(sqlCreates=>{
		// for ( var s = 0; s < sqlCreates.length; s++ ){
			// var parsed, tableName, keyName;
			// try{
				// parsed = sqliteParser(sqlCreates[s]);
			// }
			// catch(e){
				// console.log("Unable to parse query to retrieve " + tableName + " table PK: " + sqlCreates[s]);
			// }
			// // parsed contains a list of columns and constraints
			// if ( parsed && parsed.statement && parsed.statement.length && parsed.statement[0].definition && parsed.statement[0].name && parsed.statement[0].name.name){
				// var colsAndConstraints = parsed.statement[0].definition;
				// for ( var i in colsAndConstraints ){
					// // Contraint object of type PK with a list of (one or more) columns
					// if ( colsAndConstraints[i].type == "definition" && (colsAndConstraints[i].variant == "constraint") && colsAndConstraints[i].definition && colsAndConstraints[i].definition.length && (colsAndConstraints[i].definition[0].type == "constraint") && (colsAndConstraints[i].definition[0].variant == "primary key")){
						// if ( colsAndConstraints[i].columns && colsAndConstraints[i].columns.length && colsAndConstraints[i].columns[0].variant == "column" )
							// self.keyNames[parsed.statement[0].name.name] = colsAndConstraints[i].columns[0].name;
					// }
					// // Column object with a PK constraint
					// if ( colsAndConstraints[i].type == "definition" && (colsAndConstraints[i].variant == "column") && colsAndConstraints[i].definition && colsAndConstraints[i].definition.length && (colsAndConstraints[i].definition[0].type == "constraint") && (colsAndConstraints[i].definition[0].variant == "primary key"))
						// self.keyNames[parsed.statement[0].name.name] = colsAndConstraints[i].name;
				// }
			// }
		// }
	// })
	// .catch(err=>console.log(err));	
// };

// DBConnectorSQLiteBase.prototype.getColumnsInfoFromDatabase = function(tableName){
	// var self = this;
	// return this.getTableInfoFromDatabase(tableName)
	// .then(res=>{
		// if ( !res || (res.length != 1) )
			// return Promise.reject("Could not retrieve columns info for table " + tableName);
		// var sql = res[0];
		// var parsed;
		// try{
			// parsed = sqliteParser(sql);
		// }
		// catch(e){
			// console.log("Unable to parse query to retrieve " + tableName + " table columns: " + sql);
		// }
		// // parsed contains a list of columns and constraints
		// var cols = [];
		// if ( parsed && parsed.statement && parsed.statement.length && parsed.statement[0].definition ){
			// var colsAndConstraints = parsed.statement[0].definition;
			// for ( var i in colsAndConstraints ){
				// if ( colsAndConstraints[i].variant == "column" ){
					// cols.push({name:colsAndConstraints[i].name});		// colsAndConstraints[i].datatype could be added if data type were required
				// }
			// }
		// }
		// return cols;
	// })
	// .catch(err=>console.log(err));	
// };

/////////////////////////
// Sync data to server //
/////////////////////////
DBConnectorSQLiteBase.prototype.getMany = function(tableName, arrKeys){
	if ( !arrKeys || !arrKeys.length )
		return Promise.resolve([]);
	var self = this, keyName, syncCols;
	var keyName;
	return this.getKeyName(tableName)
	.then(res=>{
		keyName = res;
		return this.getSyncColumns(tableName);
	})
	.then(res=>{
		syncCols = res.join(",");
		if ( syncCols == "" )
			syncCols = "*";
		return self.openDB()
		.then(db=>{
			db.transactionSTD(function(tx){
				var sql = "SELECT " + syncCols + " FROM " + tableName + " WHERE " + keyName + " IN (" + arrKeys.join(",") + ")";
				return self.executeSQL(tx, sql, [])
				.then(data=>{
					var result = [];
					for ( var r = 0; r < data.rows.length; r++ )
						result.push(data.rows.item(r));					
					return result;
				});
			});
		})
	})
	.catch(err=>{console.log(err);});
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
		const params = {numInserts:0, numUpdates:0};
		params.sqlUpdate = "UPDATE `" + tableName + "` SET " + cols.filter(c=> c != keyName).map(c=>c + "=?").join(",") + " WHERE `" + keyName + "`=?";		// key value can't be updated
		params.sqlInsert = "INSERT INTO `" + tableName + "` (" + cols.join(",") + ") VALUES (" + cols.map(c=>"?").join(",") + ")";
		const numU = upserts.length;
		// Execute update/insert queries sequentially
		var u = 0;
		return self.executeTransaction(
			function(tx){
				var f = function(u){
					const currRow = upserts[u];
					const dataToInsert = [];
					for ( c in cols )
						dataToInsert.push(currRow[cols[c]]);
					return self.executeSQL(tx, params.sqlInsert, dataToInsert)
					.then(()=>{
						params.numInserts++;;
					})
					.catch(()=>{
						// Ignore possible duplicate key error on INSERT, try to UPDATE
						const dataToUpdate = [];
						for ( c in cols ){
							if ( cols[c] != keyName )		// key value can't be updated
								dataToUpdate.push(currRow[cols[c]]);
						}
						return self.executeSQL(tx, params.sqlUpdate, dataToUpdate.concat([currRow[keyName]]))
						.then(()=>{params.numUpdates++;});
					})
					.then(()=>{
						if ( u < numU - 1 ){
							u++;
							return f(u);
						}
					});
				};
				return f(0);
			}
		)
		.then(()=>{
			console.log("Table " + tableName + ": " + params.numInserts + " inserts, " + params.numUpdates + " updates");
			return params.numInserts;
		})
	})
	.catch(err=>{console.log(err);});
};

DBConnectorSQLiteBase.prototype.handleDeletes = function(tableName, deletes, keyName){
	var self = this;
	return self.openDB()
	.then(db=>{
		return self.executeTransaction(function(tx){
			// SQLite engine limits the number of variables to 999 per query: cut the DELETE into pieces if necessary.
			while ( deletes.length ){
				var deletesPart = deletes.splice(0,999);
				var sql = "DELETE FROM `" + tableName + "` WHERE " + keyName + " IN (" + deletesPart.map(d=>"?").join(",") + ")";
				self.executeSql(tx, sql, deletesPart);
			}
		});
	});
};


/////////////////
// Constructor //
/////////////////
function DBConnectorSQLiteBase(dbName, syncClient, whichSqlitePlugin)
{
	DBConnectorSQLBase.call(this, dbName, syncClient);
	this.name = "SQLiteBase";
	this.keyNames = {};		// will store PKs retrieved from SQLite/WebSQL database, if not provided by server's schema
	DBConnectorSQLiteBase.plugin = whichSqlitePlugin;
}