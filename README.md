# Introduction
SyncProxy-client is a javascript client for SyncProxy that enables one-single line of code implementation of synchronization for javascript offline applications using embedded database (IndexedDB, SQL Lite, WebSQL...). Used with with the SyncProxy server (www.syncproxy.com) to access the backend database (MySQL, SQL Server, MongoDB...), this is the shortest way to make mobile offline applications synchronize bi-directionally in realtime using reactive sync technology.


# Example
Simply load the SyncProxy client script from within your main index.html page:

```html
<script src="sync-client/sync-client.js" serverUrl="my.syncproxy.com" proxyID="<proxy Id>" connectorType="IndexedDB or WebSQL or SQLite or IonicStorage" dbName="<your client db name>"></script> 
```

(the script params can also be retrieved directly from my.syncproxy.com when creating a sync proxy)

# Documentation
https://github.com/hmellanger/syncproxy-quickstart-ionic
