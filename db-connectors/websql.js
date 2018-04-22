DBConnectorWebSQL.prototype = new DBConnector();

// Patch WebSQL's standard function to add automatic changes detection.
DBConnectorWebSQL.prototype.monkeyPatch = function(){
	console.log("Patching WebSQL functions...");
	// Extend openDatabase() to implement change detection on INSERTs/UPDATEs/DELETEs queries.
	openDatabaseSTD = openDatabase;		// save standard openDatabase() function.
	openDatabase = function(name, version, comments, size, onSuccess){
		var db = openDatabaseSTD(name, version, comments, size, onSuccess);
		db.__proto__.transactionSTD = db.__proto__.transaction;		// save standard transaction() function.
		db.__proto__.transaction = function(func, onError, onSuccess){
			var funcORG = func;		// save user function.
			func = function(tx){		// extend user func to intercept INSERT/UPDATE/DELETE queries and handle changes.
				tx.executeSqlSTD = tx.executeSql;		// save standard executeSql() function.
				tx.executeSql = function(sql, args, onSuccess, onError){
					var sqlObject = DBConnectorWebSQL.prototype.parseSql(sql);		// check if sql code contains an INSERT/UPDATE or DELETE operation (otherwise, will return null).
					if ( sqlObject && (sqlObject.ope == "INSERT INTO" ) ){
						var onSuccessORG = onSuccess;
						onSuccess = function(tx, data){
							// If datas have been inserted, first retrieve their rowids, then retrieve and save their PKs into localStorage.
							if ( sqlObject && sqlObject.ope == "INSERT INTO" ){
								var rowids = [];
								for ( var r = 0; r < data.rowsAffected; r++ )
								{
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
										DBConnectorWebSQL.prototype.markAsInserted(sqlObject.table, pks);
									});
								});
							}
							if ( onSuccessORG )
								onSuccessORG(tx, data);
						};
					}
					if ( sqlObject && ((sqlObject.ope == "UPDATE") || (sqlObject.ope == "DELETE FROM")) ){
						// If datas are to be updated or deleted, previously save their PKs into localStorage.
						// Run a similar SELECT query to retrieve rows, in order to mark them as updated/deleted before executing the UPDATE or DELETE.
						var sqlSelect = DBConnectorWebSQL.prototype.convertSqlToSelect(sql, sqlObject.table);
						db.transactionSTD(function(tx) {
							tx.executeSql(sqlSelect, [], function (tx, data) {		// first, execute the SELECT
								// Result of the SELECT: save PK's of records being updated or modified.
								var pks = [];
								for (var i = 0; i < data.rows.length; i++){
									pks.push(data.rows.item(i)[sqlObject.pkCol]);
								}
								if ( sqlObject.ope == "UPDATE" )
									DBConnectorWebSQL.prototype.markAsUpdated(sqlObject.table, pks);
								else if ( sqlObject.ope == "DELETE FROM" )
									DBConnectorWebSQL.prototype.markAsDeleted(sqlObject.table, pks);
							});
							tx.executeSql(sql, args, onSuccess, onError);		// finally execute the UPDATE or DELETE
						});
					}
					else
						tx.executeSqlSTD(sql, args, onSuccess, onError);
				};
				return funcORG(tx);
			};
			return db.transactionSTD(func, onError, onSuccess);
		};
		DBConnectorWebSQL.prototype.memorizePKs(db);
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

// Extract the type of operation (INSERT/UPDATE/DELETE) and the destination table. Also return table's PK column.
DBConnectorWebSQL.prototype.parseSql = function(sql){
	var result = {};
	var i = -1;
	var ops = ["INSERT INTO", "UPDATE", "DELETE FROM"];
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
	result.table = DBConnectorWebSQL.prototype.extractTableName(sql.substr(i));
	result.pkCol = DBConnectorWebSQL.prototype.getPK(result.table);
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
/////////////////
// Constructor //
/////////////////
function DBConnectorWebSQL(dbName, dbVersion)
{
	DBConnector.call(this, dbName, dbVersion);
	this.name = "WebSQL";
	this.monkeyPatch();
}