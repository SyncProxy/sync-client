DBConnectorSQLite.prototype = new DBConnector();

/////////////////
// Constructor //
/////////////////
function DBConnectorSQLite(dbName, dbVersion)
{
	DBConnector.call(this, dbName, dbVersion);
	this.name = "SQLite";
}