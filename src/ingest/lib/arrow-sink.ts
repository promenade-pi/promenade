import * as arrow from 'apache-arrow';

/**
 * Column-batch accumulator that flushes into DuckDB as Arrow IPC.
 *
 * Bounded memory is the whole point: rows accumulate into plain JS arrays only
 * up to `batchSize`, then get converted to an Arrow RecordBatch, handed to
 * DuckDB, and dropped. Nothing proportional to the log size is ever resident.
 */
export class ArrowSink {
  /**
   * @param conn  duckdb AsyncDuckDBConnection
   * @param name  target table name
   * @param schema array of [columnName, arrowType, jsType]
   */
  constructor(conn, name, schema, batchSize = 200_000) {
    this.conn = conn;
    this.name = name;
    this.schema = schema;
    this.batchSize = batchSize;
    this.cols = schema.map(() => []);
    this.n = 0;
    this.total = 0;
    this.created = false;
    this.flushes = 0;
  }

  push(values) {
    for (let i = 0; i < values.length; i++) this.cols[i].push(values[i]);
    this.n++;
    this.total++;
    return this.n >= this.batchSize;
  }

  async maybeFlush() {
    if (this.n >= this.batchSize) await this.flush();
  }

  async flush() {
    if (this.n === 0) return;
    const tEnc = performance.now();
    const fields = {};
    for (let i = 0; i < this.schema.length; i++) {
      const [col, type] = this.schema[i];
      fields[col] = arrow.vectorFromArray(this.cols[i], type);
    }
    const table = new arrow.Table(fields);
    const ipc = arrow.tableToIPC(table, 'stream');
    this.encodeMs = (this.encodeMs || 0) + (performance.now() - tEnc);
    this.ipcBytes = (this.ipcBytes || 0) + ipc.byteLength;
    const tIns = performance.now();

    if (!this.created) {
      await this.conn.insertArrowFromIPCStream(ipc, {
        name: this.name,
        create: true,
      });
      this.created = true;
    } else {
      await this.conn.insertArrowFromIPCStream(ipc, {
        name: this.name,
        create: false,
      });
    }

    this.insertMs = (this.insertMs || 0) + (performance.now() - tIns);

    // Release immediately; these arrays are the only unbounded structure here.
    this.cols = this.schema.map(() => []);
    this.n = 0;
    this.flushes++;
  }

  async finish() {
    await this.flush();
    return {
      table: this.name,
      rows: this.total,
      flushes: this.flushes,
      encodeMs: Math.round(this.encodeMs || 0),
      insertMs: Math.round(this.insertMs || 0),
      ipcBytes: this.ipcBytes || 0,
    };
  }
}

export const T = {
  str: new arrow.Utf8(),
  i32: new arrow.Int32(),
  i64: new arrow.Int64(),
  f64: new arrow.Float64(),
  bool: new arrow.Bool(),
  ts: new arrow.TimestampMillisecond(),
};
