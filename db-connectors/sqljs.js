DBConnectorSQLJS.prototype = new DBConnectorSQLBase();

const SAVEDB_TIMEOUT = 3000;

DBConnectorSQLJS.prototype.openDB = function(){
	if ( this.db )
		return Promise.resolve(this.db);
	console.log("Opening SQLJS database");
	const self = this;
	return includeFile("libs/sqljs/sqljs-standalone.min.js")
	.then(()=>{
		return window.initSqlJs();
	})
	.then(res=>{
		self.sqljs = res;
		return self.loadDB();
	})
	.then(res=>{
		console.log("Database is open");
		return res;
	})
};

DBConnectorSQLJS.prototype.loadDB = function(){
	const self = this;
	return this.readFromStorage()
	.then(res=>{
		if ( res )
			self.db = new self.sqljs.Database(res);
		else
			self.db = new self.sqljs.Database();
		self.db.isModified = false;
		self.monkeyPatch();
		return self.db
	});
};

DBConnectorSQLJS.prototype.saveDB = function(){
	const self = this;
	if ( !this.db )
		return;
	return this.writeToStorage()
	.then(res=>{
		self.db.isModified = false;
	});
};

DBConnectorSQLJS.prototype.initStorage = function(){
	window.indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
	// window.IDBTransaction = window.IDBTransaction || window.webkitIDBTransaction || window.msIDBTransaction;
	// window.IDBKeyRange = window.IDBKeyRange || window.webkitIDBKeyRange || window.msIDBKeyRange;
	return new Promise((resolve,reject)=>{
		var request = window.indexedDB.open("sqljs", 1);
		request.onerror = function (event) {
			console.log("Error during persistent storage initialization");
		};
		request.onsuccess = function (event) {
			return resolve(request.result);
		};
		request.onupgradeneeded = function (event) {
			event.target.result.createObjectStore("data")
		};
	});
};

DBConnectorSQLJS.prototype.readFromStorage = function(){
	return new Promise((resolve,reject)=>{
		this.initStorage()
		.then(db=>{
			var tx = db.transaction('data', 'readonly');
			var dataStore = tx.objectStore('data');
			var request = dataStore.get(1);
			request.onerror = function(event) {
				reject("Unable to read data from persistent storage");
			};
			request.onsuccess = function(event) {
				return resolve(request.result);
			};
		})
	})
	.then(res=>{
		console.log("SQLJS database was read from persistent storage");
		return res;
	});
};

DBConnectorSQLJS.prototype.writeToStorage = function(){
	const self = this;
	return self.initStorage()
	.then(db=>{
		var tx = db.transaction('data', 'readwrite');
		var dataStore = tx.objectStore('data');
		const binData = self.db.export();
		dataStore.put(binData, 1);
		return tx.complete;
	})
	.then(res=>{
		console.log("SQLJS database was written to persistent storage");
		return res;
	});
};

DBConnectorSQLJS.prototype.onDatabaseUpgraded = function(){
	return this.writeToStorage();
};

DBConnectorSQLJS.prototype.requestSaveDB = function(){
	this.db.isModified = true;
	if ( this.timerSaveDB )
		clearTimeout(this.timerSaveDB )
	const self = this;
	this.timerSaveDB = setTimeout(function(){
		if ( self.db.isModified ){
			self.saveDB();
			self.db.isModified = false;
		}
	}, SAVEDB_TIMEOUT);
};

DBConnectorSQLJS.prototype.monkeyPatch = function(){
	console.log("Patching " + this.name + " functions...");
	const self = this;
	if ( this.db.execSTD )
		return;
	this.db.execSTD = this.db.exec;
	this.db.runSTD = this.db.run;
	this.db.execOrRun = function(ope, sql, params){
		var res;
		const sqlObject = self.parseSql(sql, true);
		if ( sqlObject && sqlObject.pkCol && (sqlObject.ope == "INSERT") ){
			// Execute INSERT query
			res = self.db[ope + "STD"](sql, params);
			const numInserted = self.db.getRowsModified();
			// Get ROW_ID(s) of inserted row(s)
			if ( numInserted ){
				const maxRowId = self.db.execSTD("SELECT MAX(ROWID) FROM " + sqlObject.table)[0].values[0];
				const rowids = [];
				for ( var r = 0; r < numInserted; r++ ){
					var rowid = maxRowId - r;
					rowids.push(rowid);
				}
				// Get key(s) of inserted row(s) and mark for sync
				const sqlSelect = "SELECT `" + sqlObject.pkCol + "` FROM `" + sqlObject.table + "` WHERE ROWID IN (" + rowids.join(",") + ")";
				const sel = self.db.execSTD(toSelect.sql, toSelect.args);
				if ( sel && sel.length ){
					const pks = sel[0].values.map(v=>v[0]);
					self.markAsUpserted(sqlObject.table, pks);
					self.requestSaveDB();
				}
			}
		} else if ( sqlObject && sqlObject.pkCol && ((sqlObject.ope == "UPDATE") || (sqlObject.ope == "DELETE")) ){
			// Before updating/deleting, convert query into SELECT in order to get row(s) key(s)
			const toSelect = self.convertToSelect(sqlObject.table, sql, params, sqlObject.pkCol);
			if ( toSelect ){
				const sel = self.db.execSTD(toSelect.sql, toSelect.args);
				if ( sel && sel.length ){
					const pks = sel[0].values.map(v=>v[0]);
					// Mark row(s) key(s) for sync
					if ( sqlObject.ope == "UPDATE" )
						self.markAsUpserted(sqlObject.table, pks);
					else
						self.markAsDeleted(sqlObject.table, pks);
					// Run UPDATE/DELETE query
					res = self.db[ope + "STD"](sql, params);
					self.requestSaveDB();
				}
			}
		} else
			res = self.db[ope + "STD"](sql, params);
		return res;
	};
	this.db.exec = function(sql, params){
		return self.db.execOrRun("exec", sql, params);
	};
	this.db.run = function(sql, params){
		return self.db.execOrRun("run", sql, params);
	};
	console.log("...patched");
};

DBConnectorSQLJS.prototype.executeTransaction = function(transFunc){
	var self = this;
	return self.openDB()
	.then(db=>{
		return new Promise((resolve,reject)=>{
			transFunc();
			return resolve();
		});
	})
	.catch(err=>{console.log(err); return reject(err);});
};

DBConnectorSQLJS.prototype.executeSQL = function(tx, sql, params, noErrorLog){
	const self = this;
	return new Promise((resolve,reject)=>{
		var res;
		try {
			res = self.db.execSTD(sql, params);
		} catch(err){
			if ( !noErrorLog )
				console.log(err);
			return reject(err);
		}
		const rows = [];
		if ( res.length ){
			for ( var r = 0; r < res[0].values.length; r++){
				const rowVals = res[0].values[r];
				const row = {};
				for ( var c = 0; c < res[0].columns.length; c++){
					const col = res[0].columns[c];
					row[res[0].columns[c]] = rowVals[c];
				}
				rows.push(row);
			}
		}
		return resolve({rows:rows});
	})
};

DBConnectorSQLJS.prototype.handleUpserts = function(tableName, upserts, keyName){
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
		var f = function(u){
			const currRow = upserts[u];
			const dataToInsert = [];
			for ( c in cols )
				dataToInsert.push(currRow[cols[c]]);
			return self.executeSQL(null, params.sqlInsert, dataToInsert, true)
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
				return self.executeSQL(null, params.sqlUpdate, dataToUpdate.concat([currRow[keyName]]))
				.then(()=>{params.numUpdates++;});
			})
			.then(()=>{
				if ( u < numU - 1 ){
					u++;
					return f(u);
				}
			});
		};
		return f(0)
		.then(()=>{
			console.log("Table " + tableName + ": " + params.numInserts + " inserts, " + params.numUpdates + " updates");
			if ( params.numInserts || params.numUpdates )
				// self.saveDB();
				self.requestSaveDB();
			return params.numInserts;
		});
	})
	.catch(err=>{console.log(err);});
};

DBConnectorSQLJS.prototype.handleDeletes = function(tableName, deletes, keyName){
	var self = this;
	return self.openDB()
	.then(db=>{
		// SQLite engine limits the number of variables to 999 per query: cut the DELETE into pieces if necessary.
		while ( deletes.length ){
			var deletesPart = deletes.splice(0,999);
			var sql = "DELETE FROM `" + tableName + "` WHERE " + keyName + " IN (" + deletesPart.map(d=>"?").join(",") + ")";
			self.executeSQL(null, sql, deletesPart);
		}
	});
};

function DBConnectorSQLJS(dbName, syncClient) {
	DBConnectorSQLBase.call(this, dbName, syncClient);
	this.name = "SQLJS";
}