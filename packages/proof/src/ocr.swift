// On-Mac OCR for the release checks (Decision 31): Apple's Vision text recogniser, no network.
// usage: studio-ocr <image>...   prints one JSON line per image:
//   {"file": "...", "lines": [{"text": "...", "confidence": 0.98, "box": [x, y, w, h]}]}   (box: 0..1, origin top-left)
import Foundation
import Vision
import AppKit

func recognise(_ path: String) -> [String: Any] {
    guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return ["file": path, "error": "cannot read image"]
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    req.minimumTextHeight = 0.012
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch { return ["file": path, "error": "\(error)"] }
    var lines: [[String: Any]] = []
    for obs in req.results ?? [] {
        guard let top = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        lines.append(["text": top.string, "confidence": Double(top.confidence),
                      "box": [Double(b.minX), Double(1 - b.maxY), Double(b.width), Double(b.height)]])
    }
    return ["file": path, "lines": lines]
}

for path in CommandLine.arguments.dropFirst() {
    let r = recognise(path)
    if let d = try? JSONSerialization.data(withJSONObject: r), let s = String(data: d, encoding: .utf8) { print(s) }
}
