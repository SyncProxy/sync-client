const DEFAULT_DB_SIZE = 20000000;

DBConnectorWebSQL.prototype = new DBConnector();

// Patch WebSQL's standard function to add automatic changes detection.
DBConnectorWebSQL.prototype.monkeyPatch = function(){
	var self = this;
	console.log("Patching WebSQL functions...");
	// Extend openDatabase() to implement change detection on INSERTs/UPDATEs/DELETEs queries.
	openDatabaseSTD = openDatabase;		// save standard openDatabase() function.
	openDatabase = function(name, version, comments, size, onOpenSuccess){
		var db = openDatabaseSTD(name, version, comments, size, onOpenSuccess);
		db.__proto__.transactionSTD = db.__proto__.transaction;		// save standard transaction() function.
		db.__proto__.transaction = function(func, onTxError, onTxSuccess){
			var funcORG = func;		// save user function.
			var func = function(tx){		// extend user func to intercept INSERT/UPDATE/DELETE queries and handle changes.
				tx.executeSqlSTD = tx.executeSql;		// save standard executeSql() function.
				tx.executeSql = function(sql, args, onSuccess, onError){
					var sqlObject = self.parseSql(sql);		// check if sql code contains an INSERT/UPDATE or DELETE operation (otherwise, will return null).
					// if ( sqlObject && sqlObject.pkCol && ((sqlObject.ope == "INSERT INTO") || (sqlObject.ope == "INSERT OR REPLACE INTO") || (sqlObject.ope == "UPDATE") || (sqlObject.ope == "DELETE FROM")) ){
					if ( sqlObject && ((sqlObject.ope == "INSERT INTO") || (sqlObject.ope == "INSERT OR REPLACE INTO") || (sqlObject.ope == "UPDATE") || (sqlObject.ope == "DELETE FROM")) ){
						console.log(sqlObject.ope);
						var onSuccessORG = onSuccess;
						onSuccess = function(tx, result){
							console.log("SQL result:");
							console.dir(result);
							if ( onSuccessORG )
								onSuccessORG(tx, result);
						};
					}
					console.log("executeSqlSTD");
					tx.executeSqlSTD(sql, args, onSuccess, onError);
				};
				return funcORG(tx);
			};
			return db.transactionSTD(func, onTxError, onTxSuccess);
		};
		return db;
	}	
	console.log("...patched");
};

/////////////////////////////////
// Schema extraction functions //
/////////////////////////////////
DBConnectorWebSQL.prototype.extractTableName = function(sql) {
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

DBConnectorWebSQL.prototype.getKeyName = function(tableName, bSyncCall){
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
	if ( bSyncCall )
		return result;
	return Promise.resolve(result);
};

DBConnectorWebSQL.prototype.getSyncColumns = function(tableName){
	if ( !this.syncClient.schema )
		this.syncClient.loadSchema();
	var schema = this.syncClient.schema;
	for ( var t in schema.Tables ){
		if ( schema.Tables[t].Name == tableName ){
			var syncCols = [];
			var cols = schema.Tables[t].Columns;
			for ( var c in cols ){
				if ( cols[c].Sync )
					syncCols.push(cols[c].Name);
			}
			return syncCols;
		}
	}
	return [];
};

// Extract the type of operation (INSERT/UPDATE/DELETE) and the destination table. Also return table's PK column.
DBConnectorWebSQL.prototype.parseSql = function(sql){
	var result = {};
	var i = -1;
	var ops = ["INSERT INTO", "INSERT OR REPLACE INTO", "UPDATE", "DELETE FROM"];
	for ( var op in ops )
	{
		var ope = ops[op];
		if ( sql.toUpperCase().indexOf(ope) >= 0 )
		{
			result.ope = ope;
			i = sql.toUpperCase().indexOf(ope) + ope.length;
		}
	}
	if ( i == -1 )
		return null;
	result.table = this.extractTableName(sql.substr(i));
	result.pkCol = this.getKeyName(result.table, true);
	return result;
}

DBConnectorWebSQL.prototype.convertSqlToSelect = function(sql, tableName){
	// var s = "SELECT DISTINCT * FROM `" + tableName + "`";
	var s = "SELECT * FROM `" + tableName + "`";
	var posW = sql.toUpperCase().indexOf("WHERE");
	if ( posW > 0 )
		s += " " + sql.substr(posW);
	return s;
}

DBConnectorWebSQL.prototype.getDBVersion = function(){
	var v = this.getItem(this.dbName + ".dbVersion");
	if ( v )
		return v;
	return "1.0";
};

DBConnectorWebSQL.prototype.upgradeDatabase = function(newSchema){
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
	
	// TODO: upgrade database structures
	return Promise.resolve();
};

/////////////////////////
// Sync data to server //
/////////////////////////
DBConnectorWebSQL.prototype.getMany = function(tableName, arrKeys){
	if ( !arrKeys || !arrKeys.length )
		return Promise.resolve([]);
	var self = this, keyName = this.getKeyName(tableName, true);
	return new Promise(function(resolve,reject){
		var db = openDatabaseSTD(self.dbName, self.getDBVersion(), "", DEFAULT_DB_SIZE);
		db.transactionSTD(function(tx){
			var sql = "SELECT " + self.getSyncColumns(tableName).join(",") + " FROM " + tableName + " WHERE " + keyName + " IN (" + arrKeys.join(",") + ")";
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
	});
	// .catch(err=>console.log(err));
};

///////////////////////////
// Sync data from server //
///////////////////////////
/*
DBConnectorWebSQL.prototype.handleUpserts = function(tableName, upserts, keyName){
	var self = this;
	return new Promise(function(resolve,reject){
		var cols = self.getSyncColumns(tableName);
		var db = openDatabaseSTD(self.dbName, self.getDBVersion(), "", DEFAULT_DB_SIZE);
		db.transactionSTD(function(tx){
			var sql = "INSERT INTO `" + tableName + "` (`" + cols.join("`,`") + "`) VALUES (" + cols.map(c=>"?").join(",") + ")";
			// var sql = "INSERT INTO " + tableName + " (" + cols.join(",") + ") VALUES (" + cols.map(c=>"?").join(",") + ")";
			var numInserts = 0;
			for ( var u in upserts ){
				// Reorder current row's properties (JSON) to match cols order.
				var currRow = upserts[u];
				var dataToInsert = [];
				for ( c in cols )
					dataToInsert.push(currRow[cols[c]]);
				tx.executeSql(sql, dataToInsert,
					function(tx, data){
						numInserts++;
						if ( numInserts == upserts.length )
							return resolve(numInserts);
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
*/
DBConnectorWebSQL.prototype.handleUpserts = function(tableName, upserts, keyName){
	var self = this;
	return new Promise(function(resolve,reject){
		var cols = self.getSyncColumns(tableName);
		var db = openDatabaseSTD(self.dbName, self.getDBVersion(), "", DEFAULT_DB_SIZE);
		var numInserts = 0;
		db.transactionSTD(
			function(tx){
				var sql = "INSERT OR REPLACE INTO `" + tableName + "` (`" + cols.join("`,`") + "`) VALUES (" + cols.map(c=>"?").join(",") + ")";
				for ( var u in upserts ){
					// Reorder current row's properties (JSON) to match cols order.
					var currRow = upserts[u];
					var dataToInsert = [];
					for ( c in cols )
						dataToInsert.push(currRow[cols[c]]);
					tx.executeSql(sql, dataToInsert, function(){numInserts++;});
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
};

DBConnectorWebSQL.prototype.handleDeletes = function(tableName, deletes, keyName){
	var self = this;
	return new Promise(function(resolve,reject){
		var db = openDatabaseSTD(self.dbName, self.getDBVersion(), "", DEFAULT_DB_SIZE);
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
function DBConnectorWebSQL(dbName, syncClient)
{
	DBConnector.call(this, dbName, syncClient);
	this.name = "WebSQL";
	this.monkeyPatch();
}