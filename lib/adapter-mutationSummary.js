var Manipulate = require('./ops/manipulate')
var ManipulateText = require('./ops/manipulate-text')
var Move = require('./ops/move')
var isPrefixOf = require('./ops/is-prefix')
var serialize = require('serialize-dom')

exports.import = summaryToOplist


/*
Create a new MutationSummary Observer that will call
your callback with a sumary, each time a change matching one of your queries
is made to node in your rootNode.

Feed the summary to this function to create an oplist.

```
var observer = new MutationSummary({
  callback: handleChanges, // required
  rootNode: myDiv, // (defaults to window.document)
  observeOwnChanges: false // (defaults to false)
  oldPreviousSibling: false // defaults to false -- I don't understand this
  queries: [
    { ... }
  ]
});
```

You will probably want to know about all changes:

```
{ all: true }
```

A summary in this case would look like the following:

```
{
  added: [ array of <node> ],
  removed: [ array of <node> ],
  reparented: [ array of <node> ],
  reordered: [ array of <node> ],
  attributeChanged: {
    attributeName1: [ array of <element> ],
    attributeName2: [ array of <element> ], ...
  },
  characterDataChanged: [array of <node>],

  getOldAttribute: function(element, attrName) { … }, // previous attribute value
  getOldCharaterData: function(node) { … }, // text before re-setting text
  getOldParentNode: function(node) { ... }, // parent before (re)moving
  getOldPreviousSibling: function(node) { ... } // position before reordering
}
```

*/

function summaryToOplist(summary, rootNode) {
  var oplist = []

  summary.projection.processChildlistChanges()

  
  if (Array.isArray(summary.removed)) {
    summary.removed.forEach(function(node) {
      var oldParent = summary.getOldParentNode(node)
      if(oldParent && !rootNode.contains(oldParent)) {
        // my parent doesn't exist anymore, so it has prolly been removed
        // ergo this delete operation is pointless
        return
      }
      oplist.push(new Move(node.domOT_path, null, serialize(node)))
    })
  }
  
  if (Array.isArray(summary.reparented)) {
    summary.reparented.forEach(function(node) {
      var oldParent = summary.getOldParentNode(node)
        , oldPath = node.domOT_path
      
      if(oldParent && !rootNode.contains(oldParent)) {
        // my parent doesn't exist anymore, so it has prolly been removed
        // ergo, this can be treated as an insert (this is the worst case and prolly needs fixing!)
        oldPath = null
      }
      oplist.push(new Move(oldPath, pathTo(node, rootNode), serialize(node)))
    })
  }

  if (Array.isArray(summary.reordered)) {
    summary.reordered.forEach(function(node) {
      var oldParent = summary.getOldParentNode(node)
      if(oldParent && !rootNode.contains(oldParent)) {
        // parent was removed, ergo this is op pointless
        return
      }
      oplist.push(new Move(node.domOT_path, pathTo(node, rootNode)))
    })
  }

  if (Array.isArray(summary.added)) {
    summary.added
    //.reverse()// traverse added elements in reverse order, because MutationSummary puts children first for some reason
    .forEach(function(node) {
      oplist.push(new Move(null, pathTo(node, rootNode), serialize(node)))
    })
  }
  
  // Convergence over intention preservation
  // e.g. <div>hello <i>world</i></div> -> <div>hello <b><i>world</i></b></div>
  // Since Move(nul, [0,1]) already contains <i>world</i> we remove the repanting of <i>world</i>
  // We could also try to extract <i>world</i> from Move(nul, [0,1]), but that'd be more complex
  oplist = oplist.filter(function(op1) {
    // Don't insert this node if its parent is already being inserted
    if(oplist.some(function(op2) {
      if(op2 === op1) return false
      return isPrefixOf(op2.to, op1.to)
    })) {
      if(op1.from) {
        op1.to = null
        return true
      }
      else return false
    }
    return true
  })
  
  oplist.sort(sortOps)
  
  // transform non-inserts against Inserts/Moves in the order of operations
  oplist.forEach(function(op) {
    if(op.from || op.path) {
      for(var i=0; i<oplist.length; i++) {
        var op2 = oplist[i]
          , path = (op.from || op.path) && (op.from || op.path).join('')
          , path2 = op2.to && op2.to.join('')
        if(path && path2 && path > path2) {
          op.transformAgainst(op2)
        }
      }
    }
  })
  
  // transfrom moves and manipulates against (re)moves
  oplist.forEach(function(op) {
    if(op.from || op.path) { 
      for(var i=0; i<oplist.length; i++) {
        var op2 = oplist[i]
          , path = (op.from || op.path) && (op.from || op.path).join('')
          , path2 = op2.from && op2.from.join('')
        if(path && path2 && path > path2) {
          op.transformAgainst(op2)
        }
      }
    }
  })

  if(summary.attributeChanged) {
    for(var attr in summary.attributeChanged) {
      summary.attributeChanged[attr].forEach(function(node) {
        oplist.push(new Manipulate(pathTo(node, rootNode), attr, node.getAttribute(attr)))
      })
    }
  }

  if(Array.isArray(summary.characterDataChanged)) {
    summary.characterDataChanged.forEach(function(node) {
      oplist.push(new ManipulateText(pathTo(node, rootNode), node.nodeValue)) // XXX: diff!
    })
  }

  oplist.sort(sortOps)
  
  

  return oplist
}

function pathTo(node, root) {
  if(!root) throw new Error('No root node specified.')

  if(node === root) return []

  if(!root.contains(node)) {
    throw new Error('Cannot determine path. Node is not a descendant of root node.')
  }

  // The number of older siblings equals my index in the list of childNodes
  var myIndex = 0, n = node
  while(n.previousSibling) {
    n = n.previousSibling
    myIndex++
  }

  var parentPath = pathTo(node.parentNode, root)
  parentPath.push(myIndex)

  return parentPath
}

function sortOps(op1, op2) {
  var path1 = (op1.path || op1.to || op1.from).map(strPad.bind(null, '00000')).join('') // XXX: Hard limit: Can't correctly sort ops with path elements longer than 5 digits
  var path2 = (op2.path || op2.to || op2.from).map(strPad.bind(null, '00000')).join('')
  return path1 == path2? 0 : (path1 > path2? 1 : -1)
}

function strPad(paddingValue, str) {
   return String(paddingValue + str).slice(-paddingValue.length);
}

exports.createIndex = function(rootNode) {
  setIndex(rootNode, [])
}

function setIndex(node, path) {
  node.domOT_path = path
  if(node.childNodes) {
    for(var i=0; i<node.childNodes.length; i++) {
      setIndex(node.childNodes[i], path.concat([i]))
    }
  }
}
