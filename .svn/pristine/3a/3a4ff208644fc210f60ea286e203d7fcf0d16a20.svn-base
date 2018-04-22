
///////////////////////////
// Customizable handlers //
///////////////////////////
SyncClient.prototype.onOnline = function(){
	// Sync client is conncted to server and authenticated.
	console.log("Client has gone online");
};

SyncClient.prototype.onOffline = function(){
	// Sync client is conncted to server and authenticated.
	console.log("Client has gone offline");
};

SyncClient.prototype.onConnected = function(){
	// Sync client is conncted to server
	console.log("Client connected to server");
};

SyncClient.prototype.onAuthenticated = function(){
	// Sync client is conncted to server AND authenticated.
	console.log("Client authenticated");
};

SyncClient.prototype.onConnectionError = function(){
	console.log("Failed to connect to the server");
};

SyncClient.prototype.onDisconnected = function(){
	// Sync client is disconncted from server.
	console.log("Client disconnected from server");
};

SyncClient.prototype.onSyncPending = function(){
	// Sync has started.
	console.log("Sync started");
};

SyncClient.prototype.onSyncEndDefault = function(reactive){
	// Sync ended successfully.
	console.log("Sync ended successfully");
};

SyncClient.prototype.onSyncError = function(err){
	// Sync aborted with error.
	console.log("Sync aborted: " + err);
};

SyncClient.prototype.onSyncCancel = function(err){
	// Sync aborted with warning.
	console.log("Sync aborted: " + err);
};