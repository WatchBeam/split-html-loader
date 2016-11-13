'use strict';

const assert = require('assert');
const parse5 = require('parse5');
const path = require('path');
const esr = require('escape-string-regexp');
const fs = require('fs');
const loaderUtils = require('loader-utils');

/**
 * ParseError is thrown when a parsing error happens from the loader.
 */
class ParseError extends Error {
  constructor(message, node) {
    super(`INPUT:${node.__location.line}  ${message} (split-html-loader)`);
    this.originalMessage = message;
    this.name = 'ParseError';
    this.node = node;
  }

  /**
   * Updates the error message to include the filename, relative to the
   * package path.
   */
  setFilename(filename) {
    const file = './' + path.relative(findPkgRoot(__dirname), filename);
    this.message = `${file}:${this.node.__location.line}: `
        + `${this.originalMessage} (split-html-loader)\n`;
  }
}

/**
 * Attempts to find the root path of the local package installation, defaulting
 * to the filesystem root.
 */
function findPkgRoot(dir) {
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
 * If the child node is a comment element, match attempts to parse it
 * out into split-html pieces.
 */
function match(child, re) {
  if (child.nodeName !== '#comment') {
    return;
  }

  const result = re.exec(child.data);
  if (!result) {
    return;
  }

  return {
    directive: result[1] ? result[1].trim() : 'if',
    target: result[2],
    negated: !!result[3],
    value: result[4]
  };
}

/**
 * Returns the index of the END directive in the childNodes corresponding
 * to the startMatch, starting from the startIndex.
 */
function findEndIndex(startIndex, startMatch, childNodes, re) {
  for (let i = startIndex; i < childNodes.length; i++) {
    const data = match(childNodes[i], re);
    if (!data) {
      continue;
    }

    if (data.directive === 'end'
        && data.target === startMatch.target
        && data.negated === startMatch.negated
        && data.value === startMatch.value) {
      return i;
    }
  }

  return -1;
}

/**
 * Returns the index of the next concrete note after the startIndex.
 */
function findConcreteIndex(startIndex, childNodes) {
  for (let i = startIndex; i < childNodes.length; i++) {
    if (childNodes[i].nodeName[0] !== '#') {
      return i;
    }
  }

  return -1;
}

/**
 * Creates a comment saying the `n` nodes were snipped.
 */
function createSnipped(n) {
  return parse5.treeAdapters.default.createCommentNode(
    ` ${n} ${n > 1 ? 'nodes' : 'node'} snipped by split-html `
  );
}

/**
 * Strip runs the splitting on an HTML AST created by parse5.
 */
function strip(ast, options) {
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

    const value = options.targets[data.target];
    const matches = (data.value === value && !data.negated)
        || (data.value !== value && data.negated);

    switch (data.directive) {
    case 'start':
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

function run(html, options) {
  const ast = parse5.parseFragment(html, { locationInfo: true });
  const targets = Object
    .keys(options.targets)
    .map(target => esr(target))
    .join('|');
  const re = new RegExp(`^\\W*(.*?\\W)?(${targets}):\\W*(not-)?(.*?)\\W*$`);
  assert(ast.nodeName === '#document-fragment', 'Expected to have parsed a document fragment');
  strip(ast, Object.assign({ re }, options));

  return parse5.serialize(ast);
}

function loader (source) {
  let options;
  try {
    options = loaderUtils.parseQuery(this.query);
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
