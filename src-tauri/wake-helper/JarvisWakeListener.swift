import AppKit
import AVFoundation
import Foundation
import Speech

final class WakeListener {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var hasWoken = false
    private var conversationWorkItem: DispatchWorkItem?
    private var latestConversationPhrase = ""
    private let eventFile: URL?
    private let hostApp: URL?
    private let conversationMode = CommandLine.arguments.contains("--conversation")

    // “嗨 悟空” remains the public wake phrase. The other entries only
    // tolerate common on-device Mandarin homophone transcriptions.
    private let phrases = [
        "嗨悟空",
        "嘿悟空",
        "黑悟空",
    ]
    private let callWords = ["嗨", "嘿", "黑", "海", "hi", "hey"]
    private let wukongNames = ["悟空", "无空", "吴空", "五空"]

    init() {
        if
            let index = CommandLine.arguments.firstIndex(of: "--event-file"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            eventFile = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        } else {
            eventFile = nil
        }
        if
            let index = CommandLine.arguments.firstIndex(of: "--host-app"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            hostApp = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        } else {
            hostApp = nil
        }
    }

    func run() {
        emit(["type": "boot"])
        if
            let index = CommandLine.arguments.firstIndex(of: "--test-phrase"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            let phrase = CommandLine.arguments[index + 1]
            let matched = isWakePhrase(normalize(phrase))
            emit([
                "type": matched ? "wake-test-pass" : "wake-test-fail",
                "phrase": phrase,
            ])
            exit(matched ? 0 : 8)
        }
        if
            let index = CommandLine.arguments.firstIndex(of: "--test-conversation-phrase"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            emit([
                "type": "utterance",
                "phrase": CommandLine.arguments[index + 1],
            ])
            exit(0)
        }
        if CommandLine.arguments.contains("--test-wake") {
            emit(["type": "wake", "phrase": "automated cold-launch test"])
            openHostApp()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
                exit(0)
            }
            RunLoop.main.run()
            return
        }

        guard let recognizer, recognizer.isAvailable else {
            emit(["type": "error", "message": "speech recognizer unavailable"])
            exit(2)
        }

        let currentAuthorization = SFSpeechRecognizer.authorizationStatus()
        emit([
            "type": "authorization",
            "status": authorizationName(currentAuthorization),
        ])
        if currentAuthorization == .authorized {
            startRecognition()
            RunLoop.main.run()
            return
        }

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                guard status == .authorized else {
                    self.emit([
                        "type": "authorization",
                        "status": self.authorizationName(status),
                    ])
                    exit(3)
                }
                self.emit(["type": "authorization", "status": "authorized"])
                self.startRecognition()
            }
        }

        RunLoop.main.run()
    }

    private func startRecognition() {
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emit(["type": "error", "message": "microphone input unavailable"])
            exit(4)
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        guard recognizer?.supportsOnDeviceRecognition == true else {
            emit(["type": "error", "message": "on-device speech recognition unavailable"])
            exit(7)
        }
        request.requiresOnDeviceRecognition = true
        if #available(macOS 13.0, *) {
            request.addsPunctuation = false
        }
        self.request = request

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            emit(["type": "error", "message": "microphone start failed"])
            exit(5)
        }

        emit(["type": "ready"])
        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let self, !self.hasWoken else { return }
            if let result {
                let phrase = result.bestTranscription.formattedString
                let spoken = self.normalize(phrase)
                if self.conversationMode, !spoken.isEmpty {
                    self.scheduleConversationUtterance(phrase, immediate: result.isFinal)
                    return
                }
                if self.isWakePhrase(spoken) {
                    self.hasWoken = true
                    self.emit([
                        "type": "wake",
                        "phrase": result.bestTranscription.formattedString,
                    ])
                    self.stop()
                    self.openHostApp()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
                        exit(0)
                    }
                    return
                }
                if result.isFinal, !spoken.isEmpty {
                    self.emit([
                        "type": "heard",
                        "phrase": result.bestTranscription.formattedString,
                    ])
                }
            }
            if error != nil {
                self.emit(["type": "error", "message": "speech recognition interrupted"])
                self.stop()
                exit(6)
            }
        }
    }

    private func scheduleConversationUtterance(_ phrase: String, immediate: Bool) {
        latestConversationPhrase = phrase.trimmingCharacters(in: .whitespacesAndNewlines)
        conversationWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.finishConversationUtterance()
        }
        conversationWorkItem = workItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + (immediate ? 0.08 : 0.95),
            execute: workItem
        )
    }

    private func finishConversationUtterance() {
        guard !hasWoken, !latestConversationPhrase.isEmpty else { return }
        hasWoken = true
        emit(["type": "utterance", "phrase": latestConversationPhrase])
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            exit(0)
        }
    }

    private func stop() {
        conversationWorkItem?.cancel()
        conversationWorkItem = nil
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
    }

    private func openHostApp() {
        guard let hostApp else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.arguments = ["--jarvis-wake"]
        NSWorkspace.shared.openApplication(
            at: hostApp,
            configuration: configuration
        ) { [weak self] _, error in
            if let error {
                self?.emit([
                    "type": "error",
                    "message": "could not open Jarvis: \(error.localizedDescription)",
                ])
            }
        }
    }

    private func normalize(_ value: String) -> String {
        let ignored = CharacterSet.whitespacesAndNewlines
            .union(.punctuationCharacters)
            .union(.symbols)
        return String(value.lowercased().unicodeScalars.filter { !ignored.contains($0) })
    }

    private func isWakePhrase(_ spoken: String) -> Bool {
        if phrases.contains(where: spoken.contains) {
            return true
        }
        // On-device Mandarin sometimes renders “悟空” as a same-sounding
        // two-character name. Require both a call word and a Wukong alias so
        // tolerance does not turn ordinary background conversation into a wake.
        return callWords.contains(where: spoken.contains)
            && wukongNames.contains(where: spoken.contains)
    }

    private func authorizationName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    private func emit(_ value: [String: String]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: value),
            let line = String(data: data, encoding: .utf8)
        else { return }
        if let eventFile {
            let data = Data((line + "\n").utf8)
            if let handle = try? FileHandle(forWritingTo: eventFile) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
                try? handle.close()
            } else {
                try? data.write(to: eventFile, options: .atomic)
            }
        } else {
            print(line)
            fflush(stdout)
        }
    }
}

let listener = WakeListener()
listener.run()
