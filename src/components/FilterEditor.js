/* @flow */

import * as React from 'react'
import * as reltab from '../reltab'
import {Button} from '@blueprintjs/core'
import FilterEditorRow from './FilterEditorRow'

export default class FilterEditor extends React.Component {
  props: {
    schema: reltab.Schema,
    filterExp: ?reltab.FilterExp,
    onCancel: (e: any) => void,
    onApply: (fe: reltab.FilterExp) => void,
    onDone: () => void
  }
  state: {op: reltab.BoolOp, opArgs: Array<?reltab.RelExp>}

  constructor (props: any) {
    super(props)
    const { filterExp } = props
    let op, opArgs
    if (filterExp != null) {
      ({ op, opArgs } = filterExp)
    } else {
      op = 'AND'
      opArgs = [null]
    }
    this.state = {op, opArgs}
  }

  renderFilterRows () {
    const {opArgs} = this.state
    return opArgs.map((re, idx) => {
      return (<FilterEditorRow
        key={'fe-row-' + idx}
        schema={this.props.schema}
        relExp={re}
        onDeleteRow={() => this.handleDeleteRow(idx)}
        onUpdate={(re) => this.handleUpdateRow(idx, re)}
      />)
    })
  }

  handleAddRow () {
    const {opArgs} = this.state
    this.setState({ opArgs: opArgs.concat(null) })
  }

  handleDeleteRow (idx: number) {
    const {opArgs: prevArgs} = this.state
    const opArgs = prevArgs.slice()
    delete opArgs[idx]  // delete, not splice, to keep React keys correct
    this.setState({ opArgs })
  }

  handleOpChange (op: reltab.BoolOp) {
    this.setState({ op })
  }

  handleUpdateRow (idx: number, re: reltab.RelExp) {
    const {opArgs: prevArgs} = this.state
    const opArgs = (prevArgs.slice())
    opArgs[idx] = re
    this.setState({ opArgs })
  }

  handleApply () {
    const {op, opArgs} = this.state
    const nnOpArgs: any = opArgs.filter(r => r != null)
    const fe = new reltab.FilterExp(op, nnOpArgs)
    this.props.onApply(fe)
  }

  handleDone () {
    this.handleApply()
    this.props.onDone()
  }

  render () {
    const feRows = this.renderFilterRows()

    return (
      <div className='filter-editor'>
        <div className='filter-editor-filter-pane'>
          <div className='filter-editor-select-row'>
            <div className='pt-select pt-minimal'>
              <select
                onChange={e => this.handleOpChange(e.target.value)}>
                <option value='AND'>All Of (AND)</option>
                <option value='OR'>Any Of (OR)</option>
              </select>
            </div>
          </div>
          <div className='filter-editor-edit-section'>
            <div className='filter-editor-scroll-pane'>
              {feRows}
              <div className='filter-editor-row'>
                <div className='filter-edit-add-row'>
                  <Button
                    className='pt-minimal'
                    iconName='add'
                    onClick={e => this.handleAddRow()}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className='filter-editor-footer'>
          <Button
            text='Cancel'
            onClick={e => this.props.onCancel(e)} />
          <Button
            text='Apply'
            onClick={e => this.handleApply()} />
          <Button
            className='pt-intent-primary'
            onClick={e => this.handleDone()}
            text='Done' />
        </div>
      </div>
    )
  }
}
