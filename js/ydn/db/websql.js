// Copyright 2012 YDN Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Deferred wrapper for Web SQL storage.
 *
 * @see http://www.w3.org/TR/webdatabase/
 *
 * @author kyawtun@yathit.com (Kyaw Tun)
 */

goog.provide('ydn.db.WebSql');
goog.require('goog.async.Deferred');
goog.require('goog.debug.Logger');
goog.require('goog.events');
goog.require('ydn.async');
goog.require('ydn.db.tr.Db');
goog.require('ydn.db.Query');
goog.require('ydn.json');


/**
 * Construct WebSql database.
 * Note: Version is ignored, since it does work well.
 * @implements {ydn.db.tr.Db}
 * @param {string} dbname name of database.
 * @param {!ydn.db.DatabaseSchema} schema table schema contain table
 * name and keyPath.
 * @constructor
 */
ydn.db.WebSql = function(dbname, schema) {
  var self = this;
  this.dbname = dbname;
  /**
   * @final
   * @protected
   * @type {!ydn.db.DatabaseSchema}
   */
  this.schema = schema; // we always use the last schema.

  var description = this.dbname;

  /**
   * Must open the database with empty version, otherwise unrecoverable error
   * will occur in the
   * first instance.
   * @protected
   * @type {Database}
   */
  this.db = goog.global.openDatabase(this.dbname, '', description,
    this.schema.size);

  if (this.db.version != this.schema.version) {
    this.migrate();
  }

};


/**
 *
 * @return {boolean} true if supported.
 */
ydn.db.WebSql.isSupported = function() {
  return goog.isFunction(goog.global.openDatabase);
};


/**
 *
 * @define {boolean} debug flag.
 */
ydn.db.WebSql.DEBUG = false;


/**
 * @protected
 * @final
 * @type {goog.debug.Logger} logger.
 */
ydn.db.WebSql.prototype.logger = goog.debug.Logger.getLogger('ydn.db.WebSql');


/**
 * Initialize variable to the schema and prepare SQL statement for creating
 * the table.
 * @protected
 * @param {ydn.db.StoreSchema} schema name of table in the schema.
 * @return {string} SQL statement for creating the table.
 */
ydn.db.WebSql.prototype.prepareCreateTable = function(schema) {

  var sql = 'CREATE TABLE IF NOT EXISTS ' + schema.getQuotedName() + ' (';

  var id_column_name = schema.getQuotedKeyPath() ||
      ydn.db.DEFAULT_KEY_COLUMN;

  if (goog.isDef(schema.keyPath)) {
      sql += schema.getQuotedKeyPath() + ' TEXT UNIQUE PRIMARY KEY';
  } else {
    // NOTE: we could have use AUTOINCREMENT here,
    // however put request require to return key. If we use AUTOINCREMENT, the key value
    // have to query again after INSERT since it does not return any result.
    // generating the by ourselves eliminate this.
    // for generating see ydn.db.StoreSchema.prototype.generateKey
    sql += ydn.db.DEFAULT_KEY_COLUMN + ' INTEGER PRIMARY KEY';
  }

  // every table must has a default field.
  if (!schema.hasIndex(ydn.db.DEFAULT_BLOB_COLUMN)) {
    schema.addIndex(ydn.db.DEFAULT_BLOB_COLUMN);
  }

  for (var i = 0; i < schema.indexes.length; i++) {
    /**
     * @type {ydn.db.IndexSchema}
     */
    var index = schema.indexes[i];
    if (index.name == schema.keyPath) {
      continue;
    }
    var primary = index.unique ? ' UNIQUE ' : ' ';
    sql += ', ' + index.name + primary + index.type;
  }

  sql += ');';

  return sql;
};


/**
 * Migrate from current version to the last version.
 * @protected
 */
ydn.db.WebSql.prototype.migrate = function() {

  var me = this;

  /**
   * @param {SQLTransaction} transaction transaction.
   * @param {SQLResultSet} results results.
   */
  var success_callback = function(transaction, results) {
    if (ydn.db.WebSql.DEBUG) {
      window.console.log(results);
    }
    me.logger.finest('Creating tables OK.');
  };

  /**
   * @param {SQLTransaction} tr transaction.
   * @param {SQLError} error error.
   */
  var error_callback = function(tr, error) {
    if (ydn.db.WebSql.DEBUG) {
      window.console.log([tr, error]);
    }
    me.logger.warning('Error creating tables: ' + error.message);
  };

  var sqls = [];
  for (var i = 0; i < this.schema.stores.length; i++) {
    sqls.push(this.prepareCreateTable(this.schema.stores[i]));
  }

  this.db.transaction(function(t) {

    me.logger.finest('Creating tables ' + sqls.join('\n'));
    for (var i = 0; i < sqls.length; i++) {
      if (ydn.db.WebSql.DEBUG) {
        window.console.log(sqls[i]);
      }
      t.executeSql(sqls[i], [],
          i == sqls.length - 1 ? success_callback : undefined,
          error_callback);
    }
  });
};


/**
 * @param {SQLTransaction} tx
 * @param {goog.async.Deferred} df
 * @param {string} store_name table name.
 * @param {!Object|Array.<!Object>} obj object to put.
 */
ydn.db.WebSql.prototype.executePut_ = function(tx, df, store_name, obj) {

  var table = this.schema.getStore(store_name);
  if (!table) {
    this.logger.warning('Table ' + store_name + ' not found.');
    df.errback(new Error('Table ' + store_name + ' not found.'));
    return df;
  }

  var me = this;
  var is_array = goog.isArray(obj);
  var arr = is_array ? obj : [obj];
  var arr_result = [];
  var has_error = false;

  for (var i = 0; !has_error && i < arr.length; i++) {
    var last = i == arr.length - 1;

    var out = table.getIndexedValues(arr[i]);
    //console.log([obj, JSON.stringify(obj)]);

    var sql = 'INSERT OR REPLACE INTO ' + table.getQuotedName() +
        ' (' + out.columns.join(', ') + ') ' +
        'VALUES (' + out.slots.join(', ') + ');';

    /**
     * @param {SQLTransaction} transaction transaction.
     * @param {SQLResultSet} results results.
     */
    var success_callback = function(last, key, transaction, results) {
      if (ydn.db.WebSql.DEBUG) {
        window.console.log([sql, out, last, key, transaction, results]);
      }
      if (is_array) {
        arr_result.push(key);
        if (last) {
          df.callback(arr_result);
        }
      } else {
        df.callback(key);
      }
    };

    /**
     * @param {SQLTransaction} tr transaction.
     * @param {SQLError} error error.
     */
    var error_callback = function(tr, error) {
      if (ydn.db.WebSql.DEBUG) {
        window.console.log([sql, out, tr, error]);
      }
      me.logger.warning('put error: ' + error.message);
      // TODO: roll back
      has_error = true;
      df.errback(error);
    };

    //console.log([sql, out.values]);
    tx.executeSql(sql, out.values,
        goog.partial(success_callback, last, out.key), error_callback);
  }
};


/**
 * @param {string} store_name table name.
 * @param {!Object|Array.<!Object>} obj object to put.
 * @return {!goog.async.Deferred} return key in deferred function.
 */
ydn.db.WebSql.prototype.put = function(store_name, obj) {
  var df = new goog.async.Deferred();

  var me = this;

  me.db.transaction(function(tx) {
    me.executePut_(tx, df, store_name, obj);
  });
  return df;
};


/**
 * Parse resulting object of a row into original object as it 'put' into the
 * database.
 * @protected
 * @param {ydn.db.StoreSchema} table table of concern.
 * @param {!Object} row row.
 * @return {!Object} parse value.
 */
ydn.db.WebSql.prototype.parseRow = function(table, row) {
  goog.asserts.assertObject(row);
  var value = ydn.json.parse(row[ydn.db.DEFAULT_BLOB_COLUMN]);
  var key = row[table.keyPath]; // NOT: table.getKey(row);
  goog.asserts.assertString(key);
  table.setKey(value, key);
  for (var j = 0; j < table.indexes.length; j++) {
    var index = table.indexes[j];
    if (index.name == ydn.db.DEFAULT_BLOB_COLUMN) {
      continue;
    }
    var x = row[index.name];
    if (!goog.isDef(x)) {
      continue;
    }
    if (index.type == ydn.db.DataType.INTEGER) {
      x = parseInt(x, 10);
    } else if (index.type == ydn.db.DataType.FLOAT) {
      x = parseFloat(x);
    }
    value[index.name] = x;
  }
  return value;
};


/**
 * Extract key from row result.
 * @protected
 * @param {ydn.db.StoreSchema} table table of concern.
 * @param {!Object} row row.
 * @return {!Object} parse value.
 */
ydn.db.WebSql.prototype.getKeyFromRow = function(table, row) {
  return row[table.keyPath || ydn.db.DEFAULT_KEY_COLUMN];
};


/**
 * Retrieve an object from store.
 * @param {ydn.db.Key} key
 * @return {!goog.async.Deferred} return object in deferred function.
 */
ydn.db.WebSql.prototype.getByKey = function(key) {
  return this.get(key.store_name, key.id + '');
};


/**
 *
 * @param {SQLTransaction} t
 * @param {goog.async.Deferred} d
 * @param {string} arg1
 * @param {(number|string)=} key
 * @private
 */
ydn.db.WebSql.prototype.executeGet_ = function(t, d, arg1, key) {
  var table = this.schema.getStore(arg1);
  if (!table) {
    this.logger.warning('Table ' + arg1 + ' not found.');
    d.errback(new Error('Table ' + arg1 + ' not found.'));
  }

  var me = this;

  var params = [];
  if (goog.isDef(key)) {
    var sql = 'SELECT * FROM ' + table.getQuotedName() + ' WHERE ' +
        table.getQuotedKeyPath() + ' = ?';
    params = [key];
  } else {
    var sql = 'SELECT * FROM ' + table.getQuotedName();
  }

  /**
   * @param {SQLTransaction} transaction transaction.
   * @param {SQLResultSet} results results.
   */
  var callback = function (transaction, results) {
    if (!goog.isDef(key)) {
      var arr = [];
      for (var i = 0; i < results.rows.length; i++) {
        var row = results.rows.item(i);
        arr.push(me.parseRow(table, row));
      }
      d.callback(arr);
    } else if (results.rows.length > 0) {
      var row = results.rows.item(0);
      d.callback(me.parseRow(table, row));
    } else {
      d.callback(undefined);
    }
  };

  /**
   * @param {SQLTransaction} tr transaction.
   * @param {SQLError} error error.
   */
  var error_callback = function (tr, error) {
    if (ydn.db.WebSql.DEBUG) {
      window.console.log([tr, error]);
    }
    me.logger.warning('get error: ' + error.message);
    d.errback(error);
  };

  t.executeSql(sql, params, callback, error_callback);
};


/**
 * Return object
 * @param {string|!ydn.db.Query|!ydn.db.Key} arg1 table name.
 * @param {(string|number)=} key object key to be retrieved, if not provided,
 * all entries in the store will return.
 * param {number=} start start number of entry.
 * param {number=} limit maximun number of entries.
 * @return {!goog.async.Deferred} return object in deferred function.
 */
ydn.db.WebSql.prototype.get = function (arg1, key) {
  var d = new goog.async.Deferred();
  var me = this;

  if (arg1 instanceof ydn.db.Query) {
    var df = new goog.async.Deferred();

    var fetch_df = this.fetch(arg1);
    fetch_df.addCallback(function (value) {
      df.callback(goog.isArray(value) ? value[0] : undefined);
    });
    fetch_df.addErrback(function (value) {
      df.errback(value);
    });

    return df;
  } else if (arg1 instanceof ydn.db.Key) {
    return this.getByKey(arg1);
  } else {

    this.db.transaction(function (t) {
      me.executeGet_(t, d, arg1, key);
    });

    return d;
  }
};


/**
 * @inheritDoc
 */
ydn.db.WebSql.prototype.fetch = function(q, limit, offset) {
  var d = new goog.async.Deferred();
  var me = this;

  var store = this.schema.getStore(q.store);
  var is_reduce = goog.isFunction(q.reduce);

  var sql = 'SELECT * FROM ' + store.getQuotedName();
  var params = [];

  if (q.keyRange) {
  var clause = q.toWhereClause();
    sql += ' WHERE ' + '(' + clause.where_clause + ')';
    params = clause.params;
  }

  var result;

  /**
   * @param {SQLTransaction} transaction transaction.
   * @param {SQLResultSet} results results.
   */
  var callback = function(transaction, results) {
    if (!is_reduce) {
      result = [];
    }
    for (var i = 0; i < results.rows.length; i++) {
      var row = results.rows.item(i);
      var value = me.parseRow(store, row);
      var to_continue = !goog.isFunction(q.continue) || q.continue(value);
      if (!goog.isFunction(q.filter) || q.filter(value)) {

        if (goog.isFunction(q.map)) {
          value = q.map(value);
        }

        if (is_reduce) {
          result = q.reduce(result, value, i);
        } else {
          result.push(value);
        }
      }

      if (!(to_continue && (!goog.isDef(limit) || i < limit))) {
        break;
      }
    }
    d.callback(result);
  };

  /**
   * @param {SQLTransaction} tr transaction.
   * @param {SQLError} error error.
   */
  var error_callback = function(tr, error) {
    if (ydn.db.WebSql.DEBUG) {
      window.console.log([q, sql, params, limit, offset, tr, error]);
    }
    me.logger.warning('Sqlite error: ' + error.message);
    d.errback(error);
  };

  this.db.transaction(function(t) {
    //console.log([sql, clause.params]);
    t.executeSql(sql, params, callback, error_callback);
  });

  return d;
};


/**
 * Deletes all objects from the store.
 * @param {string} table_name table name.
 * @param {(string|number)=} opt_key table name.
 * @return {!goog.async.Deferred} return deferred function.
 * @private
 */
ydn.db.WebSql.prototype.clear_ = function(table_name, opt_key) {
  var d = new goog.async.Deferred();
  var self = this;

  var sql = '';
  if (goog.isDef(table_name)) {
    var store = this.schema.getStore(table_name);
    goog.asserts.assertObject(store);
    sql = 'DELETE FROM  ' + store.getQuotedName();
    if (goog.isDef(opt_key)) {
      var key_column = store.getQuotedKeyPath() || ydn.db.DEFAULT_KEY_COLUMN;
      sql += ' WHERE ' + key_column + ' = ?';
    }
  }

  /**
   * @param {SQLTransaction} transaction transaction.
   * @param {SQLResultSet} results results.
   */
  var callback = function(transaction, results) {
    d.callback(true);
  };

  /**
   * @param {SQLTransaction} tr transaction.
   * @param {SQLError} error error.
   */
  var error_callback = function(tr, error) {
    if (ydn.db.WebSql.DEBUG) {
      window.console.log([tr, error]);
    }
    self.logger.warning('Sqlite error: ' + error.message);
    d.errback(error);
  };

  this.db.transaction(function(t) {
    var arg = goog.isDef(opt_key) ? [opt_key] : [];
    t.executeSql(sql, arg, callback, error_callback);
  });
  return d;
};



/**
 * @inheritDoc
 */
ydn.db.WebSql.prototype.count = function(table) {

  var d = new goog.async.Deferred();
  var me = this;

  table = table || ydn.db.Storage.DEFAULT_TEXT_STORE;
  var sql = 'SELECT COUNT(*) FROM ' + table;

  /**
   * @param {SQLTransaction} transaction transaction.
   * @param {SQLResultSet} results results.
   */
  var callback = function(transaction, results) {
    var row = results.rows.item(0);
    //console.log(['row ', row  , results]);
    d.callback(row['COUNT(*)']);
  };

  /**
   * @param {SQLTransaction} tr transaction.
   * @param {SQLError} error error.
   */
  var error_callback = function(tr, error) {
    if (ydn.db.WebSql.DEBUG) {
      window.console.log([tr, error]);
    }
    me.logger.warning('count error: ' + error.message);
    d.errback(error);
  };

  this.db.transaction(function(t) {
    t.executeSql(sql, [], callback, error_callback);
  });

  return d;
};




/**
 *
 * @param {string} table table name.
 * @param {string} id row name.
 * @return {!goog.async.Deferred} deferred result.
 * @private
 */
ydn.db.WebSql.prototype.deleteRow_ = function(table, id) {
  var d = new goog.async.Deferred();

  var store = this.schema.getStore(table);
  if (!store) {
    this.logger.warning('Table ' + table + ' not found.');
    d.errback(new Error('Table ' + table + ' not found.'));
    return d;
  }

  var me = this;

  /**
   * @param {SQLTransaction} transaction transaction.
   * @param {SQLResultSet} results results.
   */
  var success_callback = function(transaction, results) {
    if (ydn.db.WebSql.DEBUG) {
      window.console.log(results);
    }
    d.callback(true);
  };

  /**
   * @param {SQLTransaction} tr transaction.
   * @param {SQLError} error error.
   */
  var error_callback = function(tr, error) {
    if (ydn.db.WebSql.DEBUG) {
      window.console.log([tr, error]);
    }
    me.logger.warning('put error: ' + error.message);
    d.errback(error);
  };

  me.db.transaction(function(t) {
      var sql = 'DELETE FROM ' + store.getQuotedName() +
          ' WHERE ' + store.getQuotedKeyPath() + ' = ' + goog.string.quote(id);
      //console.log([sql, out.values])
      t.executeSql(sql, [], success_callback, error_callback);
  });
  return d;
};





/**
 * Remove a specific entry from a store or all.
 * @param {string=} opt_table delete the table as provided otherwise
 * delete all stores.
 * @param {(string|number)=} opt_key delete a specific row.
 * @see {@link #remove}
 * @return {!goog.async.Deferred} return a deferred function.
 */
ydn.db.WebSql.prototype.clear = function(opt_table, opt_key) {

  if (goog.isDef(opt_table)) {    
    if (!this.schema.hasStore(opt_table)) {
      throw Error('Table ' + opt_table + ' not found.');
    }
    return this.clear_(opt_table, opt_key);
  } else {
    var dfs = [];
    for (var store in this.schema) {
      dfs.push(this.clear_(store));
    }
    return ydn.async.reduceAllTrue(new goog.async.DeferredList(dfs));
  }
};


/**
 * Delete the database, store or an entry.
 *
 * @param {string=} opt_table delete a specific store.
 * @param {string=} opt_id delete a specific row.
 * @return {!goog.async.Deferred} return a deferred function.
 */
ydn.db.WebSql.prototype.remove = function(opt_table, opt_id) {

  if (goog.isDef(opt_table)) {
    if (goog.isDef(opt_id)) {
      return this.deleteRow_(opt_table, opt_id);
    } else {
      return this.dropTable_(opt_table);
    }
  } else {
    return this.dropTable_();
  }
};

/**
 * @param {string=} opt_table table name to be deleted, if not specified all
 * tables will be deleted.
 * @return {!goog.async.Deferred} deferred result.
 * @private
 */
ydn.db.WebSql.prototype.dropTable_ = function(opt_table) {

  var d = new goog.async.Deferred();
  var me = this;

  var sql = '';
  if (goog.isDef(opt_table)) {
    var store = this.schema.getStore(opt_table);
    if (!store) {
      throw Error('Table ' + opt_table + ' not found.');
    }
    sql = sql + 'DROP TABLE ' + store.getQuotedName() + ';';
  } else {
    for (var i = 0; i < me.schema.stores.length; i++) {
      sql = sql + 'DROP TABLE ' + me.schema.stores[i].getQuotedName() + ';';
    }
  }


  /**
   * @param {SQLTransaction} transaction transaction.
   * @param {SQLResultSet} results results.
   */
  var callback = function(transaction, results) {
    //console.log(['row ', row  , results]);
    d.callback(true);
    me.logger.warning('Deleted database: ' + me.dbname);
  };

  /**
   * @param {SQLTransaction} tr transaction.
   * @param {SQLError} error error.
   */
  var error_callback = function(tr, error) {
    if (ydn.db.WebSql.DEBUG) {
      window.console.log([tr, error]);
    }
    me.logger.warning('Delete TABLE: ' + error.message);
    d.errback(error);
  };

  this.db.transaction(function(t) {
    //console.log(sql);
    t.executeSql(sql, [], callback, error_callback);
  });

  return d;
};


/**
 * @inheritDoc
 */
ydn.db.WebSql.prototype.close = function () {
  // no need to close WebSQl database.
  return goog.async.Deferred.succeed(true);
};


/**
 * @inheritDoc
 */
ydn.db.WebSql.prototype.getInTransaction = function(tx, store, id) {
  var df = new goog.async.Deferred();
  //goog.asserts.assertInstanceof(tx, SQLTransaction);
  // cannot test externs SQLTransaction, must cast
  this.executeGet_(/** @type {SQLTransaction} */ (tx), df, store, id);
  return df;
};


/**
 * @inheritDoc
 */
ydn.db.WebSql.prototype.putInTransaction = function(tx, store, value) {
  var df = new goog.async.Deferred();
  // goog.asserts.assertInstanceof(tx, SQLTransaction);
  // cannot test externs SQLTransaction, must cast
  this.executePut_(/** @type {SQLTransaction} */ (tx), df, store, value);
  return df;
};


/**
 * Get object in the store in a transaction. This return requested object
 * immediately.
 *
 * This method must be {@link #runInTransaction}.
 * @param {IDBTransaction|SQLTransaction} tx
 * @param {string} store store name.
 * @param {string|number} id object key.
 * @return {!goog.async.Deferred}
 */
ydn.db.WebSql.prototype.clearInTransaction = function(tx, store, id) {};



/**
 *
 * @inheritDoc
 */
ydn.db.WebSql.prototype.runInTransaction = function(trFn, scopes, mode, keys) {
  var df = new goog.async.Deferred();

  this.db.transaction(function(tx) {
    if (ydn.db.WebSql.DEBUG) {
      window.console.log([tx, trFn, scopes, mode, keys]);
    }

    for (var key, i = 0; key = keys[i]; i++) {
      key.tx = tx; // inject transaction object.
    }

    // now execute transaction process
    trFn();

  });

  df.addBoth(function() {
    // clean up tx.
    for (var key, i = 0; key = keys[i]; i++) {
      delete key.tx;
    }
  });

  return df;
};