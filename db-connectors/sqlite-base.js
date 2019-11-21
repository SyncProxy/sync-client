DBConnectorSQLiteBase.prototype = new DBConnector();
DBConnectorSQLiteBase.DEFAULT_DB_SIZE = 20000000;

includeFile("libs/sqliteparser.js");

// The openDatabase() parameters are different between WebSQL and SQLite implementations
DBConnectorSQLiteBase.prototype.openDB = function(){
};

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

// Get table info directly from local db strucure (if no tableName is given, get all tables)
DBConnectorSQLiteBase.prototype.getTableInfoFromDatabase = function(tableName){
	var self = this;
	return new Promise(function(resolve,reject){
		var db = self.openDB();
		db.transactionSTD(function(tx){
			var sql = "SELECT sql FROM sqlite_master WHERE type='table'";
			if ( tableName )
				sql += " AND name LIKE '" + tableName + "'";
			tx.executeSql(sql, [],
				function(tx, data){
					var sqlCreates = [];
					for ( var r = 0; r < data.rows.length; r++ )
						sqlCreates.push(data.rows.item(r).sql);				// sql is provided by SQLite as: CREATE TABLE...
					return resolve(sqlCreates);
				},
				function(tx, err){
					reject(err);
				}
			);
		});
	})
	.catch(err=>console.log(err));	
};

// Retrieve key column directly from local db strucure (if no tableName is given, get all tables)
DBConnectorSQLiteBase.prototype.getKeyNamesFromDatabase = function(tableName){
	var self = this;
	return this.getTableInfoFromDatabase(tableName)
	.then(sqlCreates=>{
		for ( var s in sqlCreates ){
			var parsed, tableName, keyName;
			try{
				parsed = sqliteParser(sqlCreates[s]);
			}
			catch(e){
				console.log("Unable to parse query to retrieve " + tableName + " table PK: " + sqlCreates[s]);
			}
			// parsed contains a list of columns and constraints
			if ( parsed && parsed.statement && parsed.statement.length && parsed.statement[0].definition && parsed.statement[0].name && parsed.statement[0].name.name){
				var colsAndConstraints = parsed.statement[0].definition;
				for ( var i in colsAndConstraints ){
					// Contraint object of type PK with a list of (one or more) columns
					if ( colsAndConstraints[i].type == "definition" && (colsAndConstraints[i].variant == "constraint") && colsAndConstraints[i].definition && colsAndConstraints[i].definition.length && (colsAndConstraints[i].definition[0].type == "constraint") && (colsAndConstraints[i].definition[0].variant == "primary key")){
						if ( colsAndConstraints[i].columns && colsAndConstraints[i].columns.length && colsAndConstraints[i].columns[0].variant == "column" )
							self.keyNames[parsed.statement[0].name.name] = colsAndConstraints[i].columns[0].name;
					}
					// Column object with a PK constraint
					if ( colsAndConstraints[i].type == "definition" && (colsAndConstraints[i].variant == "column") && colsAndConstraints[i].definition && colsAndConstraints[i].definition.length && (colsAndConstraints[i].definition[0].type == "constraint") && (colsAndConstraints[i].definition[0].variant == "primary key"))
						self.keyNames[parsed.statement[0].name.name] = colsAndConstraints[i].name;
				}
			}
		}
	})
	.catch(err=>console.log(err));	
};

DBConnectorSQLiteBase.prototype.getColumnsInfoFromDatabase = function(tableName){
	var self = this;
	return this.getTableInfoFromDatabase(tableName)
	.then(res=>{
		if ( !res || (res.length != 1) )
			return Promise.reject("Could not retrieve columns info for table " + tableName);
		var sql = res[0];
		var parsed;
		try{
			parsed = sqliteParser(sql);
		}
		catch(e){
			console.log("Unable to parse query to retrieve " + tableName + " table columns: " + sql);
		}
		// parsed contains a list of columns and constraints
		var cols = [];
		if ( parsed && parsed.statement && parsed.statement.length && parsed.statement[0].definition ){
			var colsAndConstraints = parsed.statement[0].definition;
			for ( var i in colsAndConstraints ){
				if ( colsAndConstraints[i].variant == "column" ){
					cols.push({name:colsAndConstraints[i].name});		// colsAndConstraints[i].datatype could be added if data type were required
				}
			}
		}
		return cols;
	})
	.catch(err=>console.log(err));	
};
/*
DBConnectorSQLiteBase.prototype.getKeyName = function(tableName){
	var schema = this.syncClient.schema;
	var result = null;
	if ( schema ){
		for ( var t in schema.Tables ){
			if ( schema.Tables[t].Name == tableName ){
				return Promise.resolve(schema.Tables[t].PK);
			}
		}
	}
	if ( this.keyNames[tableName] )
		return Promise.resolve(this.keyNames[tableName]);
	return Promise.resolve(null);
};
*/

// Get columns to sync from the schema.
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
					// Get names of columns of table's schema (if excludeKey is true, exclude key column).
					for ( var c in cols ){
						if ( cols[c].Sync )
							syncCols.push(cols[c]);
					}
					return resolve(syncCols);
				}
			}
		}
		return resolve([]);
	})
	.then(res=>{
		// If table's schema is not set or contains only the key column (usually NoSQL data), try to retrieve columns from local database.
		if ( (res.length > 1) || !self.getColumnsInfoFromDatabase )
			return res;
		return self.getColumnsInfoFromDatabase(tableName);		// get columns definition from database and assume they are all synched
	})
	.then(res=>{
		return res.map(c=>c.name || c.Name);
	})
	.catch(err=>{console.log(err);});
};

// Extract the type of operation (INSERT/UPDATE/DELETE) and the destination table using the sqliteParse library. Also return table's PK column.
DBConnectorSQLiteBase.prototype.parseSql = function(sql){
	if ( (sql.toUpperCase().indexOf("INSERT ") == -1) && (sql.toUpperCase().indexOf("UPDATE ") == -1) && (sql.toUpperCase().indexOf("DELETE ") == -1) )
		return Promise.resolve(null);
	var parsed;
	try{
		parsed = sqliteParser(sql);
	}
	catch(e){
		console.log("Unable to parse query for changes markup: " + sql);
	}
	var result = {};
	if ( parsed && parsed.statement && parsed.statement.length ){
		result.ope = parsed.statement[0].variant.toUpperCase();
		if (result.ope == "INSERT")
			result.table = parsed.statement[0].into.name;
		else if ( result.ope == "UPDATE" )
			result.table = parsed.statement[0].into.name;
		else if ( result.ope == "DELETE" )
			result.table = parsed.statement[0].from.name;
		else
			return Promise.resolve(null);
	}
	else
		return Promise.resolve(null);
	
	return this.getKeyName(result.table)
	.then(res=>{result.pkCol = res; return result;});
};

// Convert UPDATE or DELETE query to SELECT *
// TODO: use sqliteParser to securely detect WHERE clause (instead of simple string search for "where" occurence)
DBConnectorSQLiteBase.prototype.convertToSelect = function(tableName, sql, args, pkCol){
	var result = {args:[]};
	if ( args && args.length )
		result.args = args.slice(0);
	var sqlWhere = "";
	var wherePos = sql.toLowerCase().indexOf(" where ");
	if ( wherePos > 0 ){
		var sqlBeforeWhere = sql.substring(0, wherePos);
		sqlWhere = sql.substring(wherePos, sql.length);
		if ( args && args.length ){
			// Keep only WHERE... clause and possibly associated args (ignore previous args and SET col=val, col=val... clause of UPDATE query)
			// We assume that all args are introduced by SQL code "=?" with possible space between equal sign and question mark
			var argsBeforeWhere = sqlBeforeWhere.match(/=[ ]*\?/g);
			if ( argsBeforeWhere )
				result.args.splice(0, argsBeforeWhere.length);
		}
	}
	result.sql	= "SELECT `" + pkCol + "` FROM `" + tableName + "`" + sqlWhere;
	return result;
}

DBConnectorSQLiteBase.prototype.getDBVersion = function(){
	var v = this.getItem(this.dbName + ".dbVersion");
	if ( v )
		return v;
	if ( this.syncClient.autoUpgradeDB.toString() == "true" )
		return "0.0";
	else
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
			if ( !primaryKey && !!defaultVal )
				defaultVal = " DEFAULT " + defaultVal;
			else
				defaultVal = "";
			return col.Type + size + primaryKey + nullable + defaultVal;
		}
	}
	return null;
};

DBConnectorSQLiteBase.prototype.upgradeDatabase = function(schema){
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
				console.log(sql);
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
								// console.log("Column " + table.Name + "." + col.Name + " was not added (maybe it already exists ?)");
								// console.dir(err);
								return false;		// ignore error
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
		return new Promise(function(resolve,reject){
			var db = self.openDB();
			db.transactionSTD(function(tx){
				var sql = "SELECT " + syncCols + " FROM " + tableName + " WHERE " + keyName + " IN (" + arrKeys.join(",") + ")";
				tx.executeSql(sql, [],
					function(tx, data){
						var result = [];
						for ( var r = 0; r < data.rows.length; r++ )
							result.push(data.rows.item(r))
						return resolve(result);
					},
					function(tx, err){
						console.log(err);
						reject(err);
					}
				);
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
		return new Promise(function(resolve,reject){
			var db = self.openDB();
			var numInserts = 0;
			var sqlUpdate = "UPDATE `" + tableName + "` SET " + cols.filter(c=> c != keyName).map(c=>c + "=?").join(",") + " WHERE `" + keyName + "`=?";		// key value can't be updated
			var sqlInsert = "INSERT INTO `" + tableName + "` (" + cols.join(",") + ") VALUES (" + cols.map(c=>"?").join(",") + ")";
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
						tx.executeSql(sqlUpdate, dataToUpdate.concat([currRow[keyName]]), function(tx, result){
							// If current row was not updated, insert it
							if ( !result.rowsAffected ){
								tx.executeSql(sqlInsert, dataToInsert, function(rx,result){
									numInserts += result.rowsAffected;
								},
								function(tx, err){
									console.log(err);
									console.log(sqlInsert);
									reject(err);
								});
							}
						},
						function(tx, err){
							console.log(err);
							console.log(sqlUpdate);
							reject(err);
						});
					}
				},
				function(err){
					console.log(err);
					reject(err);
				},
				function(){
					return resolve(numInserts);
				},
			);
		});
	})
	.catch(err=>{console.log(err);});
};

DBConnectorSQLiteBase.prototype.handleDeletes = function(tableName, deletes, keyName){
	var self = this;
	return new Promise(function(resolve,reject){
		var db = self.openDB();
		db.transactionSTD(function(tx){
			// SQLite engine limits the number of variables to 999 per query: cut the DELETE into pieces if necessary.
			while ( deletes.length ){
				var deletesPart = deletes.splice(0,999);
				var sql = "DELETE FROM `" + tableName + "` WHERE " + keyName + " IN (" + deletesPart.map(d=>"?").join(",") + ")";
				tx.executeSql(sql, deletesPart,
					function(tx, data){
						return resolve();
					},
					function(tx, err){
						console.log(err);
						reject(err);
					}
				);
			}
		});
	});
};

/////////////////
// Constructor //
/////////////////
function DBConnectorSQLiteBase(dbName, syncClient, whichSqlitePlugin)
{
	DBConnector.call(this, dbName, syncClient);
	this.name = "SQLiteBase";
	this.keyNames = {};		// will store PKs retrieved from SQLite/WebSQL database, if not provided by server's schema
	DBConnectorSQLiteBase.plugin = whichSqlitePlugin;
	
	// If no schema is set, try to retrieve key columns from local database (use a timeout because DB is likely to be managed by app itself)
	var self = this;
	if ( syncClient ){
		window.setTimeout(function(){
			if ( !syncClient.schema || !Object.keys(syncClient.schema).length )
				self.getKeyNamesFromDatabase();
		}, 2000);
	}
}