/* @flow */
/**
 * Simple pure JS implementation of reltab (for use in browsers)
 *
 */

import { ConstVal, TableRep, Schema, RelExp, FilterExp, QueryExp } from './reltab'
import type { ValExp, Row, AggColSpec, SubExp, ColumnMapInfo, ColumnExtendVal } from './reltab' // eslint-disable-line
import * as d3f from 'd3-fetch'
import * as d3a from 'd3-array'

import * as _ from 'lodash'

/**
 * In older versions of d3, d3.json wasn't promise based, now it is.
 *
 */
export const fetch: (url: string) => Promise<any> = d3f.json

const loadTable = (tableName: string): Promise<TableRep> => {
  return fetch(tableName).then(jsonData => {
    // json format is [ schemaData, { rowData }]
    const [schemaData, {rowData}] = jsonData
    const schema = new Schema(schemaData.columns, schemaData.columnMetadata)
    return new TableRep(schema, rowData)
  }, error => {
    console.error('fetch failed: ', error)
  })
}

const tableCache: {[tableName: string]: Promise<TableRep>} = {}
// simple wrapper around loadTable that uses tableCache:
const tableRefImpl = (tableName: string): Promise<TableRep> => {
  var tcp = tableCache[tableName]
  if (!tcp) {
    // cache miss:
    tcp = loadTable(tableName)
    tableCache[tableName] = tcp
  }
  return tcp
}

// base expressions:  Do not have any sub-table arguments, and produce a promise<TableData>
const baseOpImplMap = {
  'table': tableRefImpl
}

const evalBaseExp = (exp: QueryExp): Promise<TableRep> => {
  const opImpl = baseOpImplMap[exp.operator]
  if (!opImpl) {
    throw new Error('evalBaseExp: unknown primitive table operator "' + exp.operator + '"')
  }
  var args = exp.valArgs
  var opRes = opImpl.apply(null, args)
  return opRes
}

/*
 * A TableOp is a function that takes a number of tables (an Array of TableRep)
 * as an argument and produces a result table
 */
type TableOp = (subTables: Array<TableRep>) => TableRep

// Given an input Schema and an array of columns to project, calculate permutation
// to apply to each row to obtain the projection
const calcProjectionPermutation = (inSchema: Schema, projectCols: Array<string>): Array<number> => {
  var perm = []
  // ensure all columns in projectCols in schema:
  for (var i = 0; i < projectCols.length; i++) {
    const colId = projectCols[ i ]
    if (!(inSchema.columnMetadata[ colId ])) {
      const err = new Error('project: unknown column Id "' + colId + '"')
      throw err
    }
    perm.push(inSchema.columnIndex(colId))
  }
  return perm
}

const projectImpl = (projectCols: Array<string>): TableOp => {
  /* Use the inImpl schema and projectCols to calculate the permutation to
   * apply to each input row to produce the result of the project.
   */
  const calcState = (inSchema: Schema): {schema: Schema, permutation: Array<number> } => {
    const perm = calcProjectionPermutation(inSchema, projectCols)
    const ns = new Schema(projectCols, inSchema.columnMetadata)

    return {schema: ns, permutation: perm}
  }

  const pf = (subTables: Array<TableRep>): TableRep => {
    const tableData = subTables[0]

    const ps = calcState(tableData.schema)
    const permuteOneRow = (row) => d3a.permute(row, ps.permutation)
    const outRowData = tableData.rowData.map(permuteOneRow)

    return new TableRep(ps.schema, outRowData)
  }

  return pf
}

/* An aggregation accumulator (AggAcc) holds hidden internal mutable
 * state to accumulate a value of type T.
 * Additional values can be added to the aggregation with mplus.
 * The result is obtained with finalize
 */
interface AggAcc<T> { // eslint-disable-line
mplus (x: ?T): void; // eslint-disable-line
finalize (): T; // eslint-disable-line
} // eslint-disable-line

class SumAgg {
  sum: number
  constructor () {
    this.sum = 0
  }

  mplus (x: ?number): void {
    if (x !== null) {
      this.sum += x
    }
  }
  finalize (): number {
    return this.sum
  }
}

class UniqAgg {
  initial: boolean
  str: ?string

  constructor () {
    this.initial = true
    this.str = null
  }

  mplus (val: any) {
    if (this.initial && val !== null) {
      // this is our first non-null value:
      this.str = val
      this.initial = false
    } else {
      if (this.str !== val) {
        this.str = null
      }
    }
  }

  finalize () {
    return this.str
  }
}

// map from column type to default agg functions:
const defaultAggs = {
  'integer': SumAgg,
  'real': SumAgg,
  'text': UniqAgg
}

/*
  function AvgAgg() {
    this.count = 0
    this.sum = 0
  }

  AvgAgg.prototype.mplus = function( val ) {
    if ( typeof val !== "undefined" ) {
      this.count++
      this.sum += val
    }
    return this
  }
  AvgAgg.prototype.finalize = function() {
    if ( this.count == 0 )
      return NaN
    return this.sum / this.count
  }

  // map of constructors for agg operators:
  var aggMap = {
    "uniq": UniqAgg,
    "sum": SumAgg,
    "avg": AvgAgg
  }
*/

const groupByImpl = (cols: Array<string>, aggs: Array<AggColSpec>): TableOp => {
  const aggCols: Array<string> = aggs // TODO: deal with explicitly specified (non-default) aggregations!

  const calcSchema = (inSchema: Schema): Schema => {
    const rs = new Schema(cols.concat(aggCols), inSchema.columnMetadata)
    return rs
  }

  const gbf = (subTables: Array<TableRep>): TableRep => {
    const tableData = subTables[0]
    const inSchema = tableData.schema
    const outSchema = calcSchema(inSchema)

    const aggCols = aggs // TODO: deal with explicitly specified (non-default) aggregations!

    // The groupMap is where actually collect each group value
    type AggGroup = { keyData: Array<any>, aggs: Array<AggAcc<any>> } // eslint-disable-line
    // let groupMap: {[groupKey: string]: AggGroup} = {}
    let groupMap = {}

    const keyPerm = calcProjectionPermutation(inSchema, cols)
    const aggColsPerm = calcProjectionPermutation(inSchema, aggCols)

    // construct and return an an array of aggregation objects appropriate
    // to each agg fn and agg column passed to groupBy

    function mkAggAccs (): Array<AggAcc<any>> { // eslint-disable-line
      return aggCols.map(colId => {
        const aggColType = inSchema.columnMetadata[colId].type
        const AggCtor = defaultAggs[aggColType]
        if (!AggCtor) {
          throw new Error('could not find aggregator for column ' + colId)
        }
        const accObj = new AggCtor()
        return accObj
      })
    }

    for (var i = 0; i < tableData.rowData.length; i++) {
      var inRow = tableData.rowData[ i ]

      var keyData = d3a.permute(inRow, keyPerm)
      var aggInData = d3a.permute(inRow, aggColsPerm)
      var keyStr = JSON.stringify(keyData)
      var groupRow = groupMap[ keyStr ]
      var aggAccs
      if (!groupRow) {
        aggAccs = mkAggAccs()
        // make an entry in our map:
        groupRow = keyData.concat(aggAccs)
        groupMap[ keyStr ] = groupRow
      }
      for (var j = keyData.length; j < groupRow.length; j++) {
        var acc = groupRow[j]
        acc.mplus(aggInData[j - keyData.length])
      }
    }

    // finalize!
    var rowData = []
    for (keyStr in groupMap) {
      if (groupMap.hasOwnProperty(keyStr)) {
        groupRow = groupMap[ keyStr ]
        keyData = groupRow.slice(0, cols.length)
        for (j = keyData.length; j < groupRow.length; j++) {
          groupRow[ j ] = groupRow[ j ].finalize()
        }
        rowData.push(groupRow)
      }
    }
    return new TableRep(outSchema, rowData)
  }

  return gbf
}

type RowPred = (row: Row) => boolean
type RowEval = (row: Row) => any

/*
 * compile the given filter expression with rest to the given schema
 */
function compileFilterExp (schema, fexp) {
  function compileAccessor (vexp: ValExp): RowEval {
    if (vexp.expType === 'ColRef') {
      const idx = schema.columnIndex(vexp.colName)
      if (typeof idx === 'undefined') {
        throw new Error('compiling filter expression: Unknown column identifier "' + vexp.colName + '"')
      }
      return row => row[idx]
    } else {
      const cexp = (vexp : ConstVal)
      return row => cexp.val
    }
  }

  const relOpFnMap = {
    'EQ': (l, r) => l === r,
    'GT': (l, r) => l > r,
    'GE': (l, r) => l >= r,
    'LE': (l, r) => l <= r,
    'LT': (l, r) => l < r
  }

  const compileRelOp = (relop: RelExp): RowPred => {
    const lhsef = compileAccessor(relop.lhs)
    const rhsef = compileAccessor(relop.rhs)
    const cmpFn = relOpFnMap[relop.op]

    function rf (row) {
      var lval = lhsef(row)
      var rval = rhsef(row)
      return cmpFn(lval, rval)
    }
    return rf
  }

  const compileSubExp = (se: SubExp): RowPred => {
    if (se.expType === 'RelExp') {
      return compileRelOp(se)
    } else if (se.expType === 'FilterExp') {
      return compileExp(se)
    } else {
      throw new Error('error compile simple expression ' + JSON.stringify(se) + ': unknown expr type')
    }
  }

  const compileAndExp = (argExps: Array<SubExp>): RowPred => {
    var argCFs = argExps.map(compileSubExp)

    function cf (row) {
      for (var i = 0; i < argCFs.length; i++) {
        var acf = argCFs[ i ]
        var ret = acf(row)
        if (!ret) {
          return false
        }
      }
      return true
    }
    return cf
  }

  const compileOrExp = (argExps: Array<SubExp>): RowPred => {
    throw new Error('OR expressions - not yet implemented')
  }

  const compileExp = (exp: FilterExp): RowPred => {
    let cfn
    if (exp.op === 'AND') {
      cfn = compileAndExp
    } else {
      cfn = compileOrExp
    }
    return cfn(exp.opArgs)
  }

  return {
    'evalFilterExp': compileExp(fexp)
  }
}

const filterImpl = (fexp: FilterExp): TableOp => {
  const ff = (subTables: Array<TableRep>): TableRep => {
    const tableData = subTables[ 0 ]

    const ce = compileFilterExp(tableData.schema, fexp)

    let outRows = []
    for (var i = 0; i < tableData.rowData.length; i++) {
      let row = tableData.rowData[i]
      if (ce.evalFilterExp(row)) {
        outRows.push(row)
      }
    }

    return new TableRep(tableData.schema, outRows)
  }

  return ff
}

/*
 * map the display name or type of columns.
 * TODO: perhaps split this into different functions since most operations are only schema transformations,
 * but type mapping will involve touching all input data.
 */
const mapColumnsImpl = (cmap: {[colName: string]: ColumnMapInfo}): TableOp => {
  // TODO: check that all columns are columns of original schema,
  // and that applying cmap will not violate any invariants on Schema....but need to nail down
  // exactly what those invariants are first!

  const mc = (subTables: Array<TableRep>): TableRep => {
    // TODO: This code now virtually identical to mapColumnsGetSchema in reltab
    // Get rid of this version and use the impl from there!
    // Problem is we've already thrown away the QueryExp when we get here
    var tableData = subTables[ 0 ]
    var inSchema = tableData.schema

    var outColumns = []
    var outMetadata = {}
    for (var i = 0; i < inSchema.columns.length; i++) {
      var inColumnId = inSchema.columns[ i ]
      var inColumnInfo = inSchema.columnMetadata[ inColumnId ]
      var cmapColumnInfo = cmap[ inColumnId ]
      if (typeof cmapColumnInfo === 'undefined') {
        outColumns.push(inColumnId)
        outMetadata[ inColumnId ] = inColumnInfo
      } else {
        var outColumnId = cmapColumnInfo.id
        if (typeof outColumnId === 'undefined') {
          outColumnId = inColumnId
        }

        // Form outColumnfInfo from inColumnInfo and all non-id keys in cmapColumnInfo:
        var outColumnInfo = JSON.parse(JSON.stringify(inColumnInfo))
        for (var key in cmapColumnInfo) {
          if (key !== 'id' && cmapColumnInfo.hasOwnProperty(key)) {
            outColumnInfo[ key ] = cmapColumnInfo[ key ]
          }
        }
        outMetadata[ outColumnId ] = outColumnInfo
        outColumns.push(outColumnId)
      }
    }
    var outSchema = new Schema(outColumns, outMetadata)

    // TODO: remap types as needed!

    return new TableRep(outSchema, tableData.rowData)
  }

  return mc
}

// colIndex is a string here because Flow doesn't support non-string keys in object literals
const mapColumnsByIndexImpl = (cmap: {[indexStr: string]: ColumnMapInfo}): TableOp => {
  // TODO: try to unify with mapColumns.  Probably means mapColumns will construct an argument to
  // mapColumnsByIndex and use this impl
  function mc (subTables) {
    var tableData = subTables[ 0 ]
    var inSchema = tableData.schema

    var outColumns = []
    var outMetadata = {}
    for (var inIndex = 0; inIndex < inSchema.columns.length; inIndex++) {
      var inColumnId = inSchema.columns[ inIndex ]
      var inColumnInfo = inSchema.columnMetadata[ inColumnId ]
      var cmapColumnInfo = cmap[ inIndex.toString() ]
      if (typeof cmapColumnInfo === 'undefined') {
        outColumns.push(inColumnId)
        outMetadata[ inColumnId ] = inColumnInfo
      } else {
        var outColumnId = cmapColumnInfo.id
        if (typeof outColumnId === 'undefined') {
          outColumnId = inColumnId
        }

        // Form outColumnfInfo from inColumnInfo and all non-id keys in cmapColumnInfo:
        var outColumnInfo = JSON.parse(JSON.stringify(inColumnInfo))
        for (var key in cmapColumnInfo) {
          if (key !== 'id' && cmapColumnInfo.hasOwnProperty(key)) {
            outColumnInfo[ key ] = cmapColumnInfo[ key ]
          }
        }
        outMetadata[ outColumnId ] = outColumnInfo
        outColumns.push(outColumnId)
      }
    }
    var outSchema = new Schema(outColumns, outMetadata)

    // TODO: remap types as needed!

    return new TableRep(outSchema, tableData.rowData)
  }

  return mc
}

/*
 * extend a RelTab by adding a column computed from existing columns.
 */
const extendImpl = (colId: string, columnMetadata: ColumnMapInfo,
ev: ColumnExtendVal): TableOp => {
  /*
   * TODO: What are the semantics of doing an extend on a column that already exists?  Decide and spec. it!
   */
  function ef (subTables) {
    var tableData = subTables[ 0 ]
    var inSchema = tableData.schema

    var outCols = inSchema.columns.concat([colId])
    let cMap = {}
    cMap[colId] = columnMetadata
    var outMetadata = _.extend(cMap, inSchema.columnMetadata)
    var outSchema = new Schema(outCols, outMetadata)

    /*
     * For now we only allow extensions to depend on columns of the original
     * table.  We may want to relax this to allow columns to depend on earlier
     * entries in columns[] array.
     */
    var outRows = []
    for (var i = 0; i < tableData.rowData.length; i++) {
      let outVal = null
      let inRow = tableData.rowData[ i ]
      /*
       * TODO: could create a RowObject with getters that uses schema to do an
       * array index into the array for the row.
       * For now we just construct the full row object (if we need it)
       */
      let outRow = inRow.slice()
      if (typeof ev === 'function') {
        let rowMap = tableData.schema.rowMapFromRow(inRow)
        outVal = ev(rowMap)
      } else {
        // extending with a constant value:
        outVal = ev
      }
      outRow.push(outVal)
      outRows.push(outRow)
    }

    return new TableRep(outSchema, outRows)
  }

  return ef
}

const concatImpl = (qexp: QueryExp): TableOp => {
  const cf = (subTables: Array<TableRep>): TableRep => {
    var tbl = subTables[ 0 ]
    var res = new TableRep(tbl.schema, tbl.rowData)
    for (var i = 1; i < subTables.length; i++) {
      tbl = subTables[ i ]
      // check schema compatibility:
      res.schema.compatCheck(tbl.schema)

      res.rowData = res.rowData.concat(tbl.rowData)
    }

    return res
  }

  return cf
}

type RowCmpFn = (rowA: Array<any>, rowB: Array<any>) => number

const compileSortFunc = (schema: Schema, keys: Array<[string, boolean]>): RowCmpFn => {
  const strcmp = (s1, s2) => (s1 < s2 ? -1 : ((s1 > s2) ? 1 : 0))
  const numcmp = (i1, i2) => i1 - i2

  var cmpFnMap = {
    'text': strcmp,
    'integer': numcmp,
    'real': numcmp
  }

  function mkRowCompFn (valCmpFn, idx, nextFunc) {
    function rcf (rowa, rowb) {
      var va = rowa[idx]
      var vb = rowb[idx]
      var ret = valCmpFn(va, vb)
      return (ret === 0 ? nextFunc(rowa, rowb) : ret)
    }

    return rcf
  }

  var rowCmpFn = function (rowa, rowb) {
    return 0
  }

  function reverseArgs (cfn) {
    const rf = (v1, v2) => cfn(v2, v1)
    return rf
  }

  for (var i = keys.length - 1; i >= 0; i--) {
    var colId = keys[i][0]
    var asc = keys[i][1]
    var idx = schema.columnIndex(colId)

    // look up comparison func for values of specific column type (taking asc in to account):
    var colType = schema.columnType(colId)
    var valCmpFn = cmpFnMap[ colType ]
    if (!asc) {
      valCmpFn = reverseArgs(valCmpFn)
    }
    rowCmpFn = mkRowCompFn(valCmpFn, idx, rowCmpFn)
  }
  return rowCmpFn
}

const sortImpl = (sortKeys: Array<[string, boolean]>): TableOp => {
  const sf = (subTables: Array<TableRep>): TableRep => {
    var tableData = subTables[ 0 ]

    var rsf = compileSortFunc(tableData.schema, sortKeys)
    // force a copy:
    var outRows = tableData.rowData.slice()
    outRows.sort(rsf)

    return new TableRep(tableData.schema, outRows)
  }
  return sf
}

const simpleOpImplMap = {
  'project': projectImpl,
  'groupBy': groupByImpl,
  'filter': filterImpl,
  'mapColumns': mapColumnsImpl,
  'mapColumnsByIndex': mapColumnsByIndexImpl,
  'extend': extendImpl,
  'concat': concatImpl,
  'sort': sortImpl
}

/*
 * Evaluate a non-base expression from its sub-tables
 */
const evalInteriorExp = (exp: QueryExp, subTables: Array<TableRep>): Promise<TableRep> => {
  const opImpl = simpleOpImplMap[exp.operator]
  if (!opImpl) {
    throw new Error('reltab query evaluation: unsupported operator "' + exp.operator + '"')
  }
  var valArgs = exp.valArgs
  var impFn = opImpl.apply(null, valArgs)
  var tres = impFn(subTables)
  return tres
}

/*
 * use simple depth-first traversal and value numbering to
 * identify common subexpressions for query evaluation.
 *
 * For now, a new evaluator is created for each top-level query
 * and only exists for the duration of query evaluation.
 * Later may want to use some more LRU-like strategy to cache
 * results across top level evaluations.
 */

/* A NumberedQuery is a QueryExp extended with an array mapping all table
 * expressions to corresponding table numbers in associated CSE Evaluator
 */
class NumberedExp {
  exp: QueryExp
  tableNums: Array<number>

  constructor (exp: QueryExp, tableNums: Array<number>) {
    this.exp = exp
    this.tableNums = tableNums
  }
}

class CSEEvaluator {
  invMap: { [expRep: string]: number } // Map from stringify'ed expr to value number
  valExps: Array<NumberedExp>
  promises: Array<Promise<TableRep>>

  constructor () {
    this.invMap = {}
    this.valExps = []
    this.promises = []
  }

  /*
   * use simple depth-first traversal and value numbering to
   * identify common table subexpressions.
   */
  buildCSEMap (query: QueryExp): number {
    const tableNums = query.tableArgs.map(e => this.buildCSEMap(e))
    const expKey = query.operator + '( [ ' + tableNums.toString() + ' ], ' + JSON.stringify(query.valArgs) + ' )'
    let valNum = this.invMap[expKey]
    if (typeof valNum === 'undefined') {
      // no entry, need to add it:
      // let's use opRep as prototype, and put tableNums in the new object:
      const numExp = new NumberedExp(query, tableNums)
      valNum = this.valExps.length
      this.valExps[valNum] = numExp
      this.invMap[expKey] = valNum
    } // else: cache hit! nothing to do

    return valNum
  }

  /* evaluate the table identified by the specified tableId using the CSE Map.
   * Returns: promise for the result value
   */
  evalTable (tableId: number): Promise<TableRep> {
    var resp = this.promises[tableId]
    if (typeof resp === 'undefined') {
      // no entry yet, make one:
      const numExp = this.valExps[tableId]

      if (numExp.tableNums.length > 0) {
        // dfs eval of sub-tables:
        const subTables = numExp.tableNums.map(tid => this.evalTable(tid))
        resp = Promise.all(subTables).then(tvals => evalInteriorExp(numExp.exp, tvals))
      } else {
        resp = evalBaseExp(numExp.exp)
      }
      this.promises[tableId] = resp
    }
    return resp
  }
}

const localEvalQuery = (query: QueryExp): Promise<TableRep> => {
  const evaluator = new CSEEvaluator()
  const tableId = evaluator.buildCSEMap(query)
  return evaluator.evalTable(tableId)
}

const localConn = {
  evalQuery: localEvalQuery
}

export {localConn as default}