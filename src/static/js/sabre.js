import _ from 'lodash'
import * as FilePond from 'filepond'
import pako from 'pako'

const submitButton = document.querySelector('#btn-submit')
const exampleButton = document.querySelector('#btn-example')
const inputFasta = document.querySelector('#fasta')
const inputCharsPerLine = document.querySelector('#chars-per-line')
const inputFile = document.querySelector('#input-file')
const resultsContainer = document.querySelector('#results-container')
const resultAlignment = document.querySelector('#result-alignment')
const notification = document.querySelector('#bgen-notification')
const error = document.querySelector('#bgen-error')
const errorMessage = document.querySelector('#error-message')
const resultLink = document.querySelector('#link-results')
const infoContent = document.querySelector('#info-content')

// TODO clean up globals...
let sequences, blockOffsets, alignmentCharactersPerLine

submitButton.addEventListener('click', run)
exampleButton.addEventListener('click', loadExample)

const fileUpload = FilePond.create(inputFile, {
  labelIdle:
    'Drop your FASTA file or <span class="filepond--label-action"> Click to browse </span>'
})

fileUpload.on('addfile', (error, file) => {
  // TODO handle properly
  if (error) {
    return
  }
  readFile(file).then(data => {
    inputFasta.value = data
  })
})

resultAlignment.addEventListener('mouseover', event => {
  const isId = event.target.matches('[data-id]')
  const isChar = event.target.matches('[data-char]')

  if (!isId && !isChar) {
    return
  }

  const lineElem = event.target.closest('[data-line]')
  const line = Number.parseInt(lineElem.dataset.line, 10)
  const seq = sequences[line]

  if (isId) {
    const html = `<table class="table">
      <tbody>
        <tr>
          <th scope="row">Seq. ID</th>
          <td>${seq.id}</td>
        </tr>
        <tr>
          <th scope="row">Seq. length</th>
          <td>${seq.ungapped.length}</td>
        </tr>
        <tr>
          <th scope="row">File header</th>
          <td>${seq.header}</td>
        </tr>
      </tbody>
    </table>`

    infoContent.innerHTML = html
    return
  }

  const blockElem = event.target.closest('[data-block]')
  const block = Number.parseInt(blockElem.dataset.block, 10)
  // cumulative sequence offset of given block
  const offBlock = blockOffsets[block][seq.id] || 0
  // offset of current line
  const offLine = [...lineElem.querySelectorAll('[data-char]')].indexOf(
    event.target
  )
  const subseq = seq.seq.substr(block * alignmentCharactersPerLine, offLine + 1)
  const posAlignment = block * alignmentCharactersPerLine + offLine + 1
  let posSeq = offBlock + ungapped(subseq).length
  if (
    posSeq === seq.ungapped.length &&
    event.target.classList.contains('end-gap')
  ) {
    posSeq += 1
  }

  const html = `<table class="table">
      <tbody>
        <tr>
          <th scope="row">Alignment pos.</th>
          <td>${posAlignment}</td>
        </tr>
        <tr>
          <th scope="row">Seq. pos.</th>
          <td>${posSeq}</td>
        </tr>
        <tr>
        <tr>
          <th scope="row">Character</th>
          <td>
            <span class="${event.target.classList.value}">${
    subseq[subseq.length - 1]
  }
            </span>
          </td>
        </tr>
        <tr>
          <th scope="row">Seq. ID</th>
          <td>${seq.id}</td>
        </tr>
        <tr>
          <th scope="row">Seq. length</th>
          <td>${seq.ungapped.length}</td>
        </tr>
        <tr>
          <th scope="row">File header</th>
          <td>${seq.header}</td>
        </tr>
      </tbody>
    </table>`

  infoContent.innerHTML = html
})

function run() {
  infoContent.innerHTML = ''
  getSequences()
  resultLink.click()

  if (sequences.length === 0) {
    showError('no sequences found')
    return
  }

  hideElement(error)
  showElement(notification)
  hideElement(resultsContainer)
  displayResults(sequences)
}

function getSequences() {
  const fasta = inputFasta.value.trim()
  sequences = parseMultiFasta(fasta)
}

function showError(message) {
  hideElement(resultsContainer)
  showElement(error)
  errorMessage.textContent = `Error: ${message}`
}

function displayResults(sequences) {
  showElement(resultsContainer)
  alignmentCharactersPerLine = parseInt(inputCharsPerLine.value, 10)
  const alignment = alignmentHtml(sequences, alignmentCharactersPerLine)
  hideElement(notification)
  resultAlignment.innerHTML = alignment
}

function showElement(element) {
  element.classList.remove('d-none')
}

function hideElement(element) {
  element.classList.add('d-none')
}

function alignmentHtml(sequences, n) {
  const chunkedSequences = sequences.map(s => chunked(s.seq, n))
  const widthLabel = Math.max(...sequences.map(s => s.id.length))
  const widthPosition = Math.max(
    ...sequences.map(s => ungapped(s.seq).length.toString().length)
  )
  const offset = {}
  blockOffsets = {}
  let ret = ''
  _.zip(...chunkedSequences).forEach((block, i) => {
    const startAlign = i * n + 1
    const widthAlign = Math.min(n, block[0].length)
    const endAlign = startAlign + widthAlign - 1

    // FIXME: get rid of `offset`, use `blockOffsets` directly instead
    blockOffsets[i] = _.cloneDeep(offset)

    ret += `<div class="alignment-block" data-block="${i}">`
    ret += `<div>${' '.repeat(
      widthLabel + widthPosition + 3
    )} ${startAlign} ${' '.repeat(
      widthAlign - startAlign.toString().length - endAlign.toString().length - 1
    )}${endAlign}</div>`

    const bases = new Map()
    for (let colIdx = 0; colIdx < widthAlign; colIdx += 1) {
      const column = block.map(line => line[colIdx])
      // filter out end gaps
      const columnFiltered = column.filter(
        (_, idx) =>
          !isEndGap(
            block[idx],
            colIdx,
            offset[sequences[idx].id],
            sequences[idx].ungapped.length
          )
      )
      const counts = _.countBy(columnFiltered)
      const countsSorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
      const countsMax = countsSorted.filter(
        ([, count]) => count === countsSorted[0][1]
      )
      const consensuses = _.map(countsMax, 0)

      for (let rowIdx = 0; rowIdx < block.length; rowIdx += 1) {
        bases[[rowIdx, colIdx]] = { classes: [] }
        if (
          !isEndGap(
            block[rowIdx],
            colIdx,
            offset[sequences[rowIdx].id],
            sequences[rowIdx].ungapped.length
          )
        ) {
          bases[[rowIdx, colIdx]].classes.push('aligned-char')
          if (
            consensuses.length > 0 &&
            !consensuses.includes(block[rowIdx][colIdx])
          ) {
            bases[[rowIdx, colIdx]].classes.push('mismatch')
          }
          // ambiguous consensus / tie
          if (
            consensuses.length > 1 &&
            consensuses.includes(block[rowIdx][colIdx])
          ) {
            bases[[rowIdx, colIdx]].classes.push('tie-match')
          }
        } else {
          bases[[rowIdx, colIdx]].classes.push('end-gap')
        }
      }
    }

    ret += `${block
      .map((line, j) => {
        const id = sequences[j].id
        const subseq = ungapped(line)
        let start = offset[id] ? offset[id] + 1 : 0
        if (offset[id]) {
          offset[id] += subseq.length
        } else if (subseq.length > 0) {
          start = 1
          offset[id] = subseq.length
        }
        const end = start + subseq.length - (subseq.length > 0 ? 1 : 0)
        return `<div class="alignment-line" data-line="${j}">${' '.repeat(
          widthLabel - id.length
        )}<span data-id>${id}</span> [${start
          .toString()
          .padStart(widthPosition)}] ${line
          .split('')
          .map(
            (char, idx) =>
              `<span class="${bases[[j, idx]].classes.join(
                ' '
              )}" data-char>${char}</span>`
          )
          .join('')} [${end
          .toString()
          .padStart(widthPosition)}] <span data-id>${id}</span></div>`
      })
      .join('')}</div>`
    ret += '</div>'
  })
  return ret
}

function chunked(seq, n) {
  const ret = []
  for (let i = 0; i < seq.length; i += n) {
    ret.push(seq.slice(i, i + n))
  }
  return ret
}

function isEndGap(line, idx, offset, seqLength) {
  // not a gap
  if (line[idx] !== '-') {
    return false
  }
  // trailing gap
  let off = offset || 0
  // account for non-gap characters in current line
  off += line.substring(0, idx).replace(/-/g, '').length
  if (off >= seqLength) {
    return true
  }
  // leading gap
  if (!offset) {
    // find first non-gap character
    const m = /[^-]/.exec(line)
    if (m === null || m.index > idx) {
      return true
    }
  }
  return false
}

function ungapped(seq) {
  return seq.replace(/-/g, '')
}

function parseMultiFasta(str) {
  const lines = str.trim().split('\n')
  const sequences = []
  let header, seq
  for (const line of lines) {
    if (line.startsWith('>')) {
      if (header) {
        sequences.push({
          header,
          id: />\s*(\S+)/.exec(header)[1],
          seq,
          ungapped: ungapped(seq)
        })
      }
      header = line
      seq = ''
    } else {
      seq += line
    }
  }
  if (header && seq) {
    sequences.push({
      header,
      id: />\s*(\S+)/.exec(header)[1],
      seq,
      ungapped: ungapped(seq)
    })
  }
  return sequences
}

function readFile(file) {
  const fileReader = new FileReader()
  const isGzip = file.fileExtension === 'gz'

  if (isGzip) {
    fileReader.readAsArrayBuffer(file.file)
  } else {
    fileReader.readAsText(file.file)
  }

  return new Promise((resolve, reject) => {
    fileReader.onload = event => {
      let content = event.target.result
      if (isGzip) {
        content = pako.ungzip(content, { to: 'string' })
      }
      resolve(content)
    }
  })
}

function loadExample() {
  inputFasta.value = exampleData
}

const exampleData = `>NFP-NFP2 (reverse)
--------------------------------------------------------------------------------
----------------------TGTCTCTGTGGATTATTCGTGGATAAGTATGTTCATGCATGTATTGCAGACCGATTGC
AACATCCATGGCAATGGTTATTCTCTGAGACCATGTAAGCGAAACCACCGAGTTTGAAGTTTTCGAAGATTCCGAGAACA
ACCACTCTTCAAGTGATCCATTTTCAGCATACTCATAGACCAGAAAACAGTTTCCATCATTGTCAGAAGACACACCCATT
AGTTTCACAAGATTTCCATGGTTTACCTTCTGCAGAATTTTCAGCTCCTCTGAAGCATCTTTTTTGATTTTTTTCACTGC
TAAAACTCTACCATCTATATTAGCCTTGTAAACTGATTCACCAATCTTACAATTGTCACTCAGATTCGTTGTACCTTCCA
TGATTGCATCAATTTCATACATTGTTGGCT--TG---CTTACAT-AACCTGAAACACCTGAAA-GTAA-CTT-ATCT-GC
AGTCTCGGACGATGAAGTACTTCTATTCAGATCTCTTCATTTTGAGACAATATACGTACACAAGTGATAGTGTTAAAACT
AAA-ATGAAAAAAGCACTTGG-----------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
------------------------------------------------------------------------
>NFP-NFP8 (forward)
CACCTTTTGCTGAACTCTTGAGTTGGTTGAAGTTCTAGCCCATCCCGAAATTCGCTATCTTGGCCTTAAAATTTGAGCCA
AGAAGGATATTACTTGTTGTGATGTCTCTGTGGATTATTCGTGGATAAGTATGTTCATGCATGTATTGCAGACCGATTGC
AACATCCATGGCAATGGTTATTCTCTGAGACCATGTAAGCGAAACCACCGAGTTTGAAGTTTTCGAAGATTCCGAGAACA
ACCACTCTTCAAGTGATCCATTTTCAGCATACTCATAGACCAGAAAACAGTTTCCATCATTGTCAGAAGACACACCCATT
AGTTTCACAAGATTTCCATGGTTTACCTTCTGCAGAATTTTCAGCTCCTCTGAAGCATCTTTTTTGATTTTTTTCACTGC
TAAAACTCTACCATCTATATTAGCCTTGTAAACTGATTCACCAATCTTACAATTGTCACTCAGATTCGTTGTACCTTCCA
TGATTGCATCAATTTCATACATTGTTGGCT--TG---CTTACAT-AACCTGAAACACCTGAAA-GTAA-CTT-ATCT-GC
AGTCTCGGACGATGAAGTACTTCTATGCA-ATCTCTTCATTTTGAGACAATATACGTACACAAGTGATAGTGTTAAAACT
AAACATGAAAAAAGCACTTCCTCAGGGT----------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
------------------------------------------------------------------------
>NFP-NFP6 (forward)
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
------------CCTCCGACTATTTCAGGGGTTGAAATTTTTAAATTCAAGACCCTTGGTGATAATTCTGGGTATGAAGT
GATTGAAAGTATGAAGAAGTTGTCACCTTGCTTGATTGAGTAGGTGATATTCGCGAAAGAGTGATTTTTAGTGCAACCAC
AAGTTACAGGTACTAGTAACAGTTGATCTGGAATCAGCTTCTTATCCTCGGCTTCTATGTTACTGGCTTTTGCAATGCGT
AAAGGACTCAAATTAAAAATATCAGATATGTTAGATAGGCTCAA--AAAATTTGGAGACTGAGCTCTGTATGCTACATAG
GTTTCACATGAAGGAGGAGAATCCACAGGGCATGTAAAGTTTGTTTCACTTATATATAGTGGTTGAGCTGAGATGTTAGT
GAGAAAAAACAACATGAGGACAAGAAAAAGAGCATGAGAACTCGAGGGAAGAAAGAAGGCAGACATTGTTGTGAGGAAAT
GCAAATTATGAGGGGAAGAGAAAAGAGAGTTTCTTATGGCAAATAACAACCAAGACTTATTGTCATACTTCT
>NFP-NFP1 (reverse)
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--A-ATGAAAAAAGCACTTCCT-AGACTGATACCAATTATAAGAGCCAGATTTTGACTGCTGCTTTTTCTTCCATTTGAA
GATGGTTGATCAAGTTTTGGTAAACTTGTCACAGGGATCAAAACTGAACGGTTGGTTGAAGCAGTGAAGTTATGATTGTT
TTCAGCTAACATTTCAACTTGTGATGCACCAAACTTTGAACTAATCAAGGGTAACATTGTCATTATCCTGCCACACATAA
GTAATAAGATACTTTATTCCTTTGTTCAATTGATTCTTTGAAGGGCACTTGCAGAATAAAGGGACTGAAACTTTGGTGTC
TAGTGGCAATAGAGTTGGACTTAGATTGGGGTTGAAATTTTTAAATTCAAGATAATTGGTGA-GATTCTGG-TATGAAGT
GATTGAAAGTATGAAGAAGTTGTCACCTTGCTTGATTGAGTAGGTGATATTCGCGAAAGAGTGATTTTTAGTGCAACCAC
AAGTTACAGGTACTAGTAACAGTTGATCTGGAATCAGCTTCTTATCCTCGGCTTCTATGTTACTGGCTTTTGCAATGCGT
AAAGGACTCAAAGTAAAAATATCAGATATGTTAGATAGGCTTAGTCAAAAGGGGGAGACTG-------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
------------------------------------------------------------------------
>NFP-NFP7 (forward)
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
----------------------------CTCCTGTGACTTACATGAACCTGAAACACCTGAAAAGTAAACTTCACCTCGC
AGTCTCGGACGATGAAGTACTTCTATTCA-ATCTCTTCATTTTGAGACAATATACGTACACAAGTGATAGTGTTAAAACT
AAA-ATGAAAAAAGCACTTCCT-AGGCTGATACCAATTATAAGAGCCAGATTTTGACTGCTGCTTTTTCTTCCATTTGAA
GATGGTTGATCAAGTTTTGGTAAACTTGTCACAGGGATCAAAACTGAACGGTTGGTTGAAGCAGTGAAGTTATGATTGTT
TTCAGCTAACATTTCAACTTGTGATGCACCAAACTTTGAACTAA-CAAGGGTAACATTGTCATTATCCTGCCACACATAA
GTAATAAGATACTTTATTCCTTTGTTCAATTGATTCTTTGAAGGGCACTTGCAGAATAAAGGGACTGAAACTTTGGTGTC
TAGTGGCAATAGAGTTGGACTTAGATTGGGGTTGAAATTTTTAAATTCAAGATAATTGGTGA-GATTCTGG-TATGAAGT
GATTGAAAGTATGAAGAAGTTGTCACCTTGCTTGATAGAGTAGGT-----------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
--------------------------------------------------------------------------------
------------------------------------------------------------------------`
