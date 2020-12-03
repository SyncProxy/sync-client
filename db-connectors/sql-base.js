DBConnectorSQLBase.prototype = new DBConnector();

includeFile("libs/sqliteparser.js");

DBConnectorSQLBase.prototype.monkeyPatch = function(){
};

/////////////////////////////////
// Schema extraction functions //
/////////////////////////////////
DBConnectorSQLBase.prototype.extractTableName = function(sql) {
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

/////////////////////////////////
// Schema extraction functions //
/////////////////////////////////
// Get table info directly from local db strucure (if no tableName is given, get all tables)
DBConnectorSQLBase.prototype.getTableInfoFromDatabase = function(tableName){
	var self = this;
	return self.openDB()
	.then(db=>{
		return new Promise((resolve,reject)=>{
			self.executeTransaction(function(tx){
				var sql = "SELECT sql FROM sqlite_master WHERE type='table'";
				if ( tableName )
					sql += " AND name LIKE '" + tableName + "'";
				return self.executeSQL(tx, sql, [])
				.then(data=>{
					var sqlCreates = [];
					for ( var r = 0; r < data.rows.length; r++ )
						sqlCreates.push(data.rows.item(r).sql);				// sql is provided by SQLite as: CREATE TABLE...
					return resolve(sqlCreates);
				});
			});
		});
	})
	.catch(err=>console.log(err));	
};

// Retrieve key column directly from local db strucure (if no tableName is given, get all tables)
DBConnectorSQLBase.prototype.getKeyNamesFromDatabase = function(tableName){
	var self = this;
	return this.getTableInfoFromDatabase(tableName)
	.then(sqlCreates=>{
		for ( var s = 0; s < sqlCreates.length; s++ ){
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

DBConnectorSQLBase.prototype.getColumnsInfoFromDatabase = function(tableName){
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

// // Get table info directly from local db strucure (if no tableName is given, get all tables)
// DBConnectorSQLBase.prototype.getTableInfoFromDatabase = function(tableName){
	// // TODO...
	// return false;
// };

// // Retrieve key column directly from local db strucure (if no tableName is given, get all tables)
// DBConnectorSQLBase.prototype.getKeyNamesFromDatabase = function(tableName){
	// // TODO...
	// return false;
// };

// DBConnectorSQLBase.prototype.getColumnsInfoFromDatabase = function(tableName){
	// // TODO...
	// return false;
// };

// Get columns to sync from the schema.
DBConnectorSQLBase.prototype.getSyncColumns = function(tableName){
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
DBConnectorSQLBase.prototype.parseSql = function(sql, synchronous){
	// Note: if several SQL statements are provided (using ";" separator), only FIRST statement is parsed 
	if ( (sql.toUpperCase().indexOf("INSERT ") == -1) && (sql.toUpperCase().indexOf("UPDATE ") == -1) && (sql.toUpperCase().indexOf("DELETE ") == -1) ){
		if ( synchronous )
			return null;
		else
			return Promise.resolve(null);
	}
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
		else {
			if ( synchronous )
				return null;
			return Promise.resolve(null);
		}
	}
	else {
		if ( synchronous )
			return null;
		return Promise.resolve(null);
	}
	if ( synchronous ){
		result.pkCol = this.getKeyName(result.table, true);
		return result;
	}
	return this.getKeyName(result.table)
	.then(res=>{result.pkCol = res; return result;});
};

// Convert UPDATE or DELETE query to SELECT *
// TODO: use sqliteParser to securely detect WHERE clause (instead of simple string search for "where" occurence)
// DBConnectorSQLBase.prototype.convertToSelect = function(tableName, sql, args, pkCol){
	// var result = {args:[]};
	// if ( args && args.length )
		// result.args = args.slice(0);
	// var sqlWhere = "";
	// var wherePos = sql.toLowerCase().indexOf(" where ");
	// if ( wherePos > 0 ){
		// var sqlBeforeWhere = sql.substring(0, wherePos);
		// sqlWhere = sql.substring(wherePos, sql.length);
		// if ( args && args.length ){
			// // Keep only WHERE... clause and possibly associated args (ignore previous args and SET col=val, col=val... clause of UPDATE query)
			// // We assume that all args are introduced by SQL code "=?" with possible space between equal sign and question mark
			// var argsBeforeWhere = sqlBeforeWhere.match(/=[ ]*\?/g);
			// if ( argsBeforeWhere )
				// result.args.splice(0, argsBeforeWhere.length);
		// }
	// }
	// result.sql	= "SELECT `" + pkCol + "` FROM `" + tableName + "`" + sqlWhere;
	// return result;
// }

// Convert sql UPDATE/DELETE to SELECT
DBConnectorSQLBase.prototype.convertToSelect = function(tableName, sql, args, pkCol){
	// Replace
	// UPDATE <table> SET <...> [WHERE <...>] or DELETE FROM <table> [WHERE <...>]
	// with
	// SELECT * FROM <table> [WHERE <...>]
	// sqliteParser helps to safely locate the WHERE clause
	const parsed = sqliteParser(sql);
	var stmt, checkTableName, ope;
	if ( parsed || parsed.statement || parsed.statement.length )
		stmt = parsed.statement[0];
	if ( stmt && stmt.set && (stmt.variant == "update") && (stmt.into.variant == "table") )
		checkTableName = stmt.into.name;
	else 	if ( stmt && stmt.from && (stmt.variant == "delete") && (stmt.from.variant == "table") )
		checkTableName = stmt.from.name;
	if ( !checkTableName || (checkTableName.toUpperCase() != tableName.toUpperCase()) ){
		console.log("Could not parse query for table " + tableName + ":");
		console.log(sql);
		return null;
	}
	var sqlWhere = "", wherePos = -1;
	if ( stmt.where ){
		// if sql contains a WHERE clause, safely find its position
		var countBefore = 0;
		if ( stmt.variant == "update" ){
			// Count occurence of the word "WHERE" preceeding the WHERE clause
			var s = (JSON.stringify(stmt.into) + " " + JSON.stringify(stmt.set)).toUpperCase();
			countBefore = (s.match(/WHERE/g) || []).length;
		}
		wherePos = sql.toUpperCase().split("WHERE", countBefore + 1).join("WHERE").length;
		if ( wherePos == sql.length )
			wherePos = -1;
		else
			sqlWhere = sql.substr(wherePos);
	}
	var result = {args:[]};
	if ( args && args.length )
		result.args = args.slice(0);
	if ( wherePos > 0 ){
		var sqlBeforeWhere = sql.substring(0, wherePos);
		if ( args && args.length ){
			// Keep only WHERE... clause and possibly associated args (ignore previous args and SET col=val, col=val... clause of UPDATE query)
			// We assume that all args are introduced by SQL code "=?" with possible space between equal sign and question mark
			var argsBeforeWhere = sqlBeforeWhere.match(/=[ ]*\?/g);
			if ( argsBeforeWhere )
				result.args.splice(0, argsBeforeWhere.length);
		}
	}
	result.sql	= "SELECT `" + pkCol + "` FROM `" + tableName + "` " + sqlWhere;
	return result;
}

DBConnectorSQLBase.prototype.getDBVersion = function(){
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
DBConnectorSQLBase.prototype.getColDef = function(table, colName){
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

DBConnectorSQLBase.prototype.onDatabaseUpgraded = function(){
	return Promise.resolve();
};

DBConnectorSQLBase.prototype.upgradeDatabase = function(schema){
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
	
	return self.openDB()
	.then(db=>{
		return self.executeTransaction(
			function(tx){
				// Create tables of the new schema (when not exist)
				for ( var t = 0; t < schema.Tables.length; t++ ){
					const table = schema.Tables[t];
					if ( !table.PK ){
						console.log("Table " + table.Name + " was not created because it has not primary key");
						continue;
					}
					var sql = "CREATE TABLE IF NOT EXISTS `" + table.Name + "` (`" + table.PK + "` " + self.getColDef(table, table.PK) + ")";
					console.log(sql);
					self.executeSQL(tx, sql, [])
					.then(result=>{
						// Create columns
						for ( var c = 0; c < table.Columns.length; c++ ){
							const col = table.Columns[c];
							if ( col.Name == table.PK )
								continue;
							var sqlAddCol = "ALTER TABLE `" + table.Name + "` ADD `" + col.Name + "` " + self.getColDef(table, col.Name);
							console.log(sqlAddCol);
							self.executeSQL(tx, sqlAddCol, [], true)
							.catch(()=>false);	// ignore ALTER TABLE error
						}
					})
					.catch(err=>{
						console.log("Error creating table " + table.Name);
						console.dir(err);
						Promise.reject(err);
					});
				}
			}
		)
		.then(()=>self.onDatabaseUpgraded());
	});
}


/////////////////////////
// Sync data to server //
/////////////////////////
// DBConnectorSQLBase.prototype.getMany = function(tableName, arrKeys){
	// if ( !arrKeys || !arrKeys.length )
		// return Promise.resolve([]);
	// var self = this, keyName, syncCols;
	// var keyName;
	// return this.getKeyName(tableName)
	// .then(res=>{
		// keyName = res;
		// return this.getSyncColumns(tableName);
	// })
	// .then(res=>{
		// syncCols = res.join(",");
		// if ( syncCols == "" )
			// syncCols = "*";
		// return self.openDB()
		// .then(db=>{
			// db.transactionSTD(function(tx){
				// var sql = "SELECT " + syncCols + " FROM " + tableName + " WHERE " + keyName + " IN (" + arrKeys.join(",") + ")";
				// return self.executeSQL(tx, sql, [])
				// .then(data=>{
					// var result = [];
					// for ( var r = 0; r < data.rows.length; r++ )
						// result.push(data.rows.item(r))
					// return result;
				// })
			// });
		// })
	// })
	// .catch(err=>{console.log(err);});
// };
DBConnectorSQLBase.prototype.getMany = function(tableName, arrKeys){
	if ( !arrKeys || !arrKeys.length )
		return Promise.resolve([]);
	var self = this, keyName, syncCols;
	var keyName;
	return this.getKeyName(tableName)
	.then(res=>{
		keyName = res;
		return self.getSyncColumns(tableName);
	})
	.then(res=>{
		syncCols = res.join(",");
		if ( syncCols == "" )
			syncCols = "*";
		return self.openDB()
		.then(db=>{
			return new Promise((resolve,reject)=>{
				return self.executeTransaction(function(tx){
					var sql = "SELECT " + syncCols + " FROM " + tableName + " WHERE " + keyName + " IN (" + arrKeys.join(",") + ")";
					return self.executeSQL(tx, sql, [])
					.then(data=>{
						var result = [];
						for ( var r = 0; r < data.rows.length; r++ ){
							const row = data.rows.item ? data.rows.item(r) : data.rows[r];
							// result.push(data.rows.item(r))
							result.push(row);
						}						
						return resolve(result);
					})
				});
			});
		})
	})
	.catch(err=>{console.log(err);});
};

/////////////////
// Constructor //
/////////////////
function DBConnectorSQLBase(dbName, syncClient)
{
	DBConnector.call(this, dbName, syncClient);
	this.name = "SQLBase";
	this.keyNames = {};		// will store PKs retrieved from SQLite/WebSQL database, if not provided by server's schema
	
	// If no schema is set, try to retrieve key columns from local database (use a timeout because DB is likely to be managed by app itself)
	var self = this;
	if ( syncClient ){
		var physicalSchemaReadDelay = syncClient.scriptParams["physicalSchemaReadDelay"];
		if ( physicalSchemaReadDelay ){
			window.setTimeout(function(){
				if ( !syncClient.schema || !Object.keys(syncClient.schema).length )
					self.getKeyNamesFromDatabase();
			}, physicalSchemaReadDelay);
		}
	}
}	