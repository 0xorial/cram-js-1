/* eslint-disable no-continue,no-plusplus */
const AbortablePromiseCache = require('abortable-promise-cache').default
const QuickLRU = require('quick-lru')

const { promisify } = require('es6-promisify')
const zlib = require('zlib')

const gunzip = promisify(zlib.gunzip)

const { open } = require('./io')
const { CramMalformedError } = require('./errors')

const BAI_MAGIC = 21578050 // BAI\1

class Slice {
  constructor(args) {
    Object.assign(this, args)
  }

  toString() {
    return `${this.start}:${this.span}:${this.containerStart}:${this.sliceStart}:${this.sliceBytes}`
  }
}

function addRecordToIndex(index, record) {
  if (record.some(el => el === undefined)) {
    throw new CramMalformedError('invalid .crai index file')
  }

  const [seqId, start, span, containerStart, sliceStart, sliceBytes] = record

  if (!index[seqId]) {
    index[seqId] = []
  }

  index[seqId].push(
    new Slice({
      start,
      span,
      containerStart,
      sliceStart,
      sliceBytes,
    }),
  )
}
class CraiIndex {
  // A CRAM index (.crai) is a gzipped tab delimited file containing the following columns:
  // 1. Sequence id
  // 2. Alignment start
  // 3. Alignment span
  // 4. Container start byte position in the file
  // 5. Slice start byte position in the container data (‘blocks’)
  // 6. Slice size in bytes
  // Each line represents a slice in the CRAM file. Please note that all slices must be listed in index file.

  /**
   *
   * @param {object} args
   * @param {string} [args.path]
   * @param {string} [args.url]
   * @param {FileHandle} [args.filehandle]
   */
  constructor(args) {
    const filehandle = open(args.url, args.path, args.filehandle)
    this._parseCache = new AbortablePromiseCache({
      cache: new QuickLRU({ maxSize: 1 }),
      fill: (data, signal) => this.parseIndex({ signal }),
    })
    this.readFile = filehandle.readFile.bind(filehandle)
  }

  parseIndex() {
    const index = {}
    return this.readFile()
      .then(data => {
        if (data[0] === 31 && data[1] === 139) return gunzip(data)
        return data
      })
      .then(uncompressedBuffer => {
        if (
          uncompressedBuffer.length > 4 &&
          uncompressedBuffer.readUInt32LE(0) === BAI_MAGIC
        ) {
          throw new CramMalformedError(
            'invalid .crai index file. note: file appears to be a .bai index. this is technically legal but please open a github issue if you need support',
          )
        }
        // interpret the text as regular ascii, since it is supposed to be only
        // digits and whitespace characters this is written in a deliberately
        // low-level fashion for performance, because some .crai files can be
        // pretty large.
        let currentRecord = []
        let currentString = ''
        for (let i = 0; i < uncompressedBuffer.length; i += 1) {
          const charCode = uncompressedBuffer[i]
          if (
            (charCode >= 48 && charCode <= 57) /* 0-9 */ ||
            (!currentString && charCode === 45) /* leading - */
          ) {
            currentString += String.fromCharCode(charCode)
          } else if (charCode === 9 /* \t */) {
            currentRecord.push(Number.parseInt(currentString, 10))
            currentString = ''
          } else if (charCode === 10 /* \n */) {
            currentRecord.push(Number.parseInt(currentString, 10))
            currentString = ''
            addRecordToIndex(index, currentRecord)
            currentRecord = []
          } else if (charCode !== 13 /* \r */ && charCode !== 32 /* space */) {
            // if there are other characters in the file besides
            // space and \r, something is wrong.
            throw new CramMalformedError('invalid .crai index file')
          }
        }

        // if the file ends without a \n, we need to flush our buffers
        if (currentString) {
          currentRecord.push(Number.parseInt(currentString, 10))
        }
        if (currentRecord.length === 6) {
          addRecordToIndex(index, currentRecord)
        }

        // sort each of them by start
        Object.entries(index).forEach(([seqId, ent]) => {
          index[seqId] = ent.sort(
            (a, b) => a.start - b.start || a.span - b.span,
          )
        })
        return index
      })
  }

  getIndex(opts = {}) {
    return this._parseCache.get('index', null, opts.signal)
  }

  /**
   * @param {number} seqId
   * @returns {Promise} true if the index contains entries for
   * the given reference sequence ID, false otherwise
   */
  async hasDataForReferenceSequence(seqId) {
    return !!(await this.getIndex())[seqId]
  }

  async indexQuery(seqId, pos) {
    const seqEntries = (await this.getIndex())[seqId]
    if (!seqEntries) {
      return []
    }

    // This sequence is covered by the index, so binary search to find
    // the optimal starting block. adapted from samtools
    let j = seqEntries.length - 1
    let i = 0
    for (let k = Math.floor(j / 2); k !== i; k = Math.floor((j - i) / 2) + i) {
      const entry = seqEntries[k]
      if (entry.start >= pos) {
        j = k
        continue
      }
      if (entry.start < pos) {
        i = k
        continue
      }
    }

    if (j >= 0 && seqEntries[j].start < pos) {
      i = j
    }

    while (i > 0 && seqEntries[i - 1].start + seqEntries[i - 1].span >= pos) {
      i--
    }

    while (
      i + 1 < seqEntries.length &&
      (seqEntries[i].start && seqEntries[i].start + seqEntries[i].span < pos)
    ) {
      i++
    }
    return i
  }

  async indexQueryLast(seqId, pos) {
    const seqEntries = (await this.getIndex())[seqId]

    let first = await this.indexQuery(seqId, pos)
    const last = seqEntries.length - 1
    while (first < last && seqEntries[first + 1].start <= pos) {
      first++
    }
    return first
  }

  /**
   * fetch index entries for the given range
   *
   * @param {number} seqId
   * @param {number} queryStart
   * @param {number} queryEnd
   *
   * @returns {Promise} promise for
   * an array of objects of the form
   * `{start, span, containerStart, sliceStart, sliceBytes }`
   */
  async getEntriesForRange(seqId, queryStart, queryEnd) {
    const seqEntries = (await this.getIndex())[seqId]
    if (!seqEntries) {
      return []
    }

    // this emulates the htslib code for cram_index.c indexQuery and indexQueryLast
    const start = await this.indexQuery(seqId, queryStart)
    const end = await this.indexQueryLast(seqId, queryEnd)

    return seqEntries.slice(start, end + 1)
  }
}

module.exports = CraiIndex
