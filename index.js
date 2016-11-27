'use strict';

const assert = require('assert');
const parse5 = require('parse5');
const path = require('path');
const esr = require('escape-string-regexp');
const qs = require('querystring');
const fs = require('fs');

/**
 * Attempts to find the root path of the local package installation, defaulting
 * to the filesystem root.
 * @param {string} dir
 * @return {string}
 */
function findPkgRoot (dir) {
  if (dir === '/') {
    return dir;
  }

  try {
    fs.accessSync(path.join(dir, 'package.json'), fs.F_OK);
    return dir;
  } catch (e) { /* ignored */ }

  return findPkgRoot(path.dirname(dir));
}

/**
 * @external ASTNode
 * @see {@link https://github.com/inikulin/parse5/wiki/Documentation|parse5}
 */

/**
 * ParseError is thrown when a parsing error happens from the loader.
 */
class ParseError extends Error {
  /**
   * @param  {string} message
   * @param  {ASTNode} node
   */
  constructor (message, node) {
    super(`INPUT:${node.__location.line}  ${message} (split-html-loader)`);
    this.originalMessage = message;
    this.name = 'ParseError';
    this.node = node;
  }

  /**
   * Updates the error message to include the filename, relative to the
   * package path.
   * @param {string} filename
   */
  setFilename (filename) {
    const file = `./${path.relative(findPkgRoot(__dirname), filename)}`;
    this.message = `${file}:${this.node.__location.line}: `
        + `${this.originalMessage} (split-html-loader)\n`;
  }
}

/**
 * @typedef {Object} MatchResult
 * @property {string} directive
 * @property {boolean} negated
 * @property {string} name
 */

/**
 * If the child node is a comment element, match attempts to parse it
 * out into split-html pieces.
 * @param {ASTNode} child
 * @param {RegExp} re
 * @return {MatchResult}
 */
function match (child, re) {
  if (child.nodeName !== '#comment') {
    return;
  }

  const result = re.exec(child.data);
  if (!result) {
    return;
  }

  return {
    directive: result[1] ? result[1].trim() : 'if',
    negated: !!result[2],
    name: result[3],
  };
}

/**
 * Returns the index of the END directive in the childNodes corresponding
 * to the startMatch, starting from the startIndex.
 * @param {number} startIndex
 * @param {MatchResult} startMatch
 * @param {ASTNode[]} childNodes
 * @param {RegExp} re
 * @return {number}
 */
function findEndIndex (startIndex, startMatch, childNodes, re) {
  for (let i = startIndex; i < childNodes.length; i++) {
    const data = match(childNodes[i], re);
    if (!data) {
      continue;
    }

    if (data.directive === 'end'
        && data.negated === startMatch.negated
        && data.name === startMatch.name) {
      return i;
    }
  }

  return -1;
}

/**
 * Returns the index of the next concrete note after the startIndex.
 * @param {number} startIndex
 * @param {ASTNode[]} childNodes
 * @return {number}
 */
function findConcreteIndex (startIndex, childNodes) {
  for (let i = startIndex; i < childNodes.length; i++) {
    if (childNodes[i].nodeName[0] !== '#') {
      return i;
    }
  }

  return -1;
}

/**
 * Creates a comment saying the `n` nodes were snipped.
 * @param {number} n
 * @return {ASTNode.<CommentNode>}
 */
function createSnipped (n) {
  return parse5.treeAdapters.default.createCommentNode(
    ` ${n} ${n > 1 ? 'nodes' : 'node'} snipped by split-html `
  );
}

/**
 * @typedef {Object} SplitOptions
 * @param {RegExp} re Internally set.
 * @param {string} value
 * @param {string} target
 */

/**
 * Strip runs the splitting on an HTML AST created by parse5.
 * @param {ASTNode.<document>} ast
 * @param {SplitOptions} options
 */
function strip (ast, options) {
  if (!ast.childNodes) {
    return;
  }

  let children = ast.childNodes;
  const ends = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const data = match(child, options.re);
    if (!data) {
      strip(children[i], options);
      continue;
    }

    const matches = (data.name === options.value && !data.negated)
        || (data.name !== options.value && data.negated);

    switch (data.directive) {
    case 'start': {
      // On a START directive, look for the matching END block. Remove
      // everything including the START and END blocks if it doesn't match.
      const end = findEndIndex(i + 1, data, children, options.re);
      if (end === -1) {
        throw new ParseError('Cannot find END of directive block', child);
      }

      ends.push(children[end]);
      if (!matches) {
        children = ast.childNodes = children
          .slice(0, i + 1)
          .concat(createSnipped(end - i))
          .concat(children.slice(end));
      }
      break;
    }
    case 'if':
      // For "IF"s, just look for and remove the next *concrete*
      // element if it doesn't match.
      const toRemove = findConcreteIndex(i + 1, children);
      if (toRemove === -1) {
        throw new ParseError('Dangling split block, expected another node after this line!', child);
      }
      if (!matches) {
        children = ast.childNodes = children
          .slice(0, i + 1)
          .concat(createSnipped(toRemove - i))
          .concat(children.slice(toRemove + 1));
      }
      break;
    case 'end':
      // If we got an END block and we didn't have a matching START block, error!
      if (ends.indexOf(child) === -1) {
        throw new ParseError('Found an END directive block without a start', child);
      }
      break;

    default:
      throw new ParseError(
        `Found a malformed directive block "${children[i].data.trim()}"`,
        child
      );
    }
  }
}

/**
 * Performs html splitting on a string.
 * @param  {string} html
 * @param  {SplitOptions} options
 * @return {string}
 */
function run (html, options) {
  const ast = parse5.parseFragment(html, { locationInfo: true });
  const re = new RegExp(`^\\W*(.*?\\W)?${esr(options.target)}:\\W*(not-)?(.*?)\\W*$`);
  assert(ast.nodeName === '#document-fragment', 'Expected to have parsed a document fragment');
  strip(ast, Object.assign({ re }, options));

  return parse5.serialize(ast);
}

/**
 * Called from webpack.
 * @param  {string} source
 * @return {string}
 */
function loader (source) {
  let options;
  try {
    options = qs.parse(this.query.slice(1));
  } catch (err) {
    throw new Error(
      'Split-css-loader is unable to parse the provided query string. ' +
      'Please see usage instructions here: https://git.io/vXmzf'
    );
  }

  this.cacheable();
  try {
    return run(source, options);
  } catch (e) {
    if (e instanceof ParseError) {
      e.setFilename(this.resource);
    }
    throw e;
  }
}

module.exports = loader;
module.exports.string = run;
