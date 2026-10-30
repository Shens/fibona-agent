// Fibona on iOS: the host around core.js, the way fibona.py and bootstraps/terminal are around core/.
// main.m gives this file one object, `native` (cls, send, block, delegate, log). From it this file builds
// Objective-C access, the console, timers and HTTP, then runs boot.js and the agent.
// Like core.js it ships read-only in the app bundle, so the agent can never break it.

const IPHONE = `
## The iPhone

You run inside an iPhone app, in JavaScriptCore, on the main thread. Besides standard JavaScript there are
\`setTimeout\`/\`clearTimeout\` and \`await http(url, {method, headers, body})\`, resolving to \`{status, text}\`.
The host is source_code['app.js']; read it for details.

- **Files** persist in \`DOCS\` (Documents); variables do not outlive the app. \`DOCS + "/boot.js"\`, if present,
  runs as a cell at every launch, before you wake: write what you build there to become it. After 3 failed
  launches in a row it is moved to \`boot.failed.js\`. Every cell, across launches, is a line of
  \`DOCS + "/history.jsonl"\`, shaped like \`history\`'s records. When the app is ended and opened again, the
  console shows its conversation as it was and the run goes on: \`history\` holds its cells again, numbered on,
  and the next message the user sends continues it. Do not replay history into the console yourself.
- **Objective-C**: \`ObjC.UILabel\` is a class; a method call sends its selector with \`_\` for each \`:\`, as in
  \`ObjC.UILabel.alloc().initWithFrame_([0, 0, 200, 40])\`. Strings, numbers, booleans, arrays and plain objects
  convert both ways and come back as plain JS values; call methods on them with
  \`ObjC.send(value, "selector:", ...args)\`. Structs are number arrays (a CGRect is \`[x, y, width, height]\`),
  pointer arguments accept only \`null\`, and constants are their string values ("NSFont").
- \`ObjC.block(types, fn)\` makes a completion block: "v", "v@", "v@@", "v@@@", "vB" or "vB@".
  \`ObjC.delegate(handlers, protocols)\` makes a delegate or target from functions named like selectors
  (\`tableView_numberOfRowsInSection_\`); name its protocols so argument and return types are known.
- UIKit holds delegates and targets weakly: keep them in globals. An invalid call throws; a wrong pointer or a
  freed object crashes the app, and this session with it.
- Build interfaces with UIKit (SwiftUI is not reachable) in your own UIWindow, made with
  \`ObjC.UIWindow.alloc().initWithWindowScene_(windowScene)\` (one made with initWithFrame_ joins no scene and never
  shows), then hide the console with \`consoleWindow.setHidden_(true)\`. The user can reopen it with the floating
  spiral button.
- **Home-screen widget**: Fibona's widget shows PNGs you draw into \`ObjC.FBWidget.directory()\`, named by the Unix
  time they start showing, with optional tap regions in \`<image>.json\`; call \`ObjC.FBWidget.reload()\` after writing.
  Its rules are in source_code['widget/Widget.swift']. It needs an app group, which this build leaves out for
  personal teams; without one \`directory()\` is null and the widget stays empty.
- **Permissions and capabilities** are fixed at build time. Info.plist
  (\`ObjC.NSBundle.mainBundle().infoDictionary()\`) lists the usage strings and background modes; on a device, the
  bundle's embedded.mobileprovision lists the entitlements. Request authorization before use. Files cannot be read
  while the phone is locked.
- **Your app in use**: what runs outside cells (callbacks, timers, boot.js) prints to \`app_log\`, along with
  callback errors; build_context() shows the newest lines. Check it first when the user reports a problem.
- **Using your app**: call its functions and read its state directly, or act as the user: walk the view tree,
  type with \`setText_\`, tap with \`sendActionsForControlEvents_(64)\`. Taps skip hit-testing, so also look:
  \`screenshot()\` returns a PNG data URL to send to call_me as \`{type: "input_image", image_url: ...}\`.
`.trim();

// --- OBJC ----------------------------------------------------------------------------------------------
// Objective-C objects arrive as opaque wrappers; `wrap` gives them methods, so label.setText_("hi") sends
// setText:. Converted values (strings, numbers, arrays, plain objects) pass through as they are.

const RAW = Symbol("raw");
const isPlain = (v) => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const isObjC = (v) => typeof v === "function" || (v !== null && typeof v === "object" && !Array.isArray(v) && !isPlain(v));
const mapValues = (o, fn) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(v)]));

function wrap(v) {
  if (Array.isArray(v)) return v.map(wrap);
  if (isPlain(v)) return mapValues(v, wrap);
  if (!isObjC(v)) return v;
  return new Proxy(v, {
    get(target, key) {
      if (key === RAW) return target;
      if (typeof key === "symbol" || key === "then") return undefined;  // Not a thenable, so it can be awaited.
      const selector = ["toString", "toJSON", "valueOf"].includes(key) ? "description" : key.replaceAll("_", ":");
      return (...args) => wrap(native.send(target, selector, args.map(unwrap)));
    },
  });
}

function unwrap(v) {
  if (v?.[RAW]) return v[RAW];
  if (Array.isArray(v)) return v.map(unwrap);
  if (isPlain(v)) return mapValues(v, unwrap);
  return v;
}

// A callback's errors go to the console and app_log instead of vanishing into native code.
// While it runs, prints also go to app_log. ponytail: an async callback's prints after its first await are not counted.
let callbackDepth = 0;
const asCallback = (fn) => {
  callbackDepth += 1;
  try {
    return fn();
  } finally {
    callbackDepth -= 1;
  }
};
const guard = (fn) => (...args) => {
  const report = (e) => asCallback(() => print(`Callback error: ${e}\n${e?.stack ?? ""}`));
  try {
    const result = asCallback(() => fn(...args.map(wrap)));
    if (typeof result?.then === "function") result.then(null, report);  // An async callback fails later.
    return unwrap(result);
  } catch (e) {
    report(e);
  }
};

globalThis.ObjC = new Proxy({
  send: (target, selector, ...args) => wrap(native.send(unwrap(target), selector, args.map(unwrap))),
  block: (types, fn) => wrap(native.block(types, guard(fn))),
  delegate: (handlers, protocols = []) =>
    wrap(native.delegate(Object.setPrototypeOf(mapValues(handlers, guard), null), protocols)),
}, {
  get: (helpers, name) => (typeof name === "symbol" || name === "then" ? undefined : helpers[name] ?? wrap(native.cls(name))),
});

// The app's one window scene, current even after the system replaces it. Every window must join it to show.
Object.defineProperty(globalThis, "windowScene", { get: () => wrap(native.scene()) });

// --- CONSOLE -------------------------------------------------------------------------------------------
// Laid out and colored like bootstraps/terminal: the conversation, the composer, then a status line that keeps
// moving while the agent works (state, elapsed time, and tokens per second while the model streams).

// The name on the home screen (Info.plist), so messages and notifications tell this build apart from the official app.
const APP_NAME = String(ObjC.NSBundle.mainBundle().objectForInfoDictionaryKey_("CFBundleDisplayName") ?? "Fibona");

const rgb = (hex) => ObjC.UIColor.colorWithRed_green_blue_alpha_(
  ...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), 1);
const COLORS = mapValues({ background: "#20202e", text: "#d6d6dd", composer: "#41414e", status: "#a4cea2",
  user: "#f0a6ca", cell: "#ba94ed", logo: "#78628f", notice: "#9494a4", error: "#f18c8c", speed: "#e5c07b" }, rgb);
const COMPOSER_MAX = 124;  // About five lines.
const mono = (size, weight = 0) => ObjC.UIFont.monospacedSystemFontOfSize_weight_(size, weight);
const LOGO = `███████╗██╗██████╗  ██████╗ ███╗   ██╗ █████╗
██╔════╝██║██╔══██╗██╔═══██╗████╗  ██║██╔══██╗
█████╗  ██║██████╔╝██║   ██║██╔██╗ ██║███████║
██╔══╝  ██║██╔══██╗██║   ██║██║╚██╗██║██╔══██║
██║     ██║██████╔╝╚██████╔╝██║ ╚████║██║  ██║
╚═╝     ╚═╝╚═════╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝`;

class Console {
  // The app's own windows: the conversation and composer above all others, and a floating button that toggles
  // them. The user's way in, even when the agent's windows are broken. As in bootstraps/terminal, a line can be sent
  // only while a cell waits in input(); otherwise Return keeps the text in the composer.
  // Delegates, targets and the timer are kept as fields, because UIKit holds the first two weakly.
  waiting = [];  // input() calls not yet answered
  secret = false;  // The pending input is shown masked once sent.
  fallback = null;  // What an empty reply to the pending input means; null when a reply must not be empty.
  welcome = true;
  segments = [];  // The conversation since the welcome text as [text, color, kind], kept in TRANSCRIPT.
  ended = false;  // Whether the run ended, so the next launch starts a new one instead of continuing it.
  unsaved = false;  // Whether TRANSCRIPT lacks some of the above.
  savedAt = 0;  // When it was last written, or tried.
  state = "Ready";
  started = Date.now();
  modelRequests = 0;
  retryAt = 0;  // When a rate-limited model request is sent again; 0 when none waits. See request.
  tokenSamples = [];  // [time, total tokens]

  constructor() {
    const screen = ObjC.UIScreen.mainScreen().bounds();
    this.window = ObjC.UIWindow.alloc().initWithWindowScene_(windowScene);
    this.window.setWindowLevel_(2001);  // Above alerts (2000).
    this.window.setOverrideUserInterfaceStyle_(2);  // Dark.
    this.window.setRootViewController_(ObjC.UIViewController.new());
    const view = this.window.rootViewController().view();
    view.setBackgroundColor_(COLORS.background);

    this.log = ObjC.UITextView.new();
    this.log.setEditable_(false);
    this.log.setBackgroundColor_(COLORS.background);
    this.log.setTextContainerInset_([8, 4, 8, 4]);

    // The composer wraps and grows with its text up to COMPOSER_MAX points, then scrolls. Return sends.
    this.field = ObjC.UITextView.new();
    this.field.setBackgroundColor_(COLORS.composer);
    this.field.setTextColor_(COLORS.text);
    this.field.setTintColor_(COLORS.cell);
    this.field.setFont_(mono(15));
    this.field.layer().setCornerRadius_(10);
    this.field.setTextContainerInset_([12, 28, 12, 12]);  // Room for the › prompt on the left.
    this.field.setReturnKeyType_(7);  // Send.
    this.field.setScrollEnabled_(false);
    const prompt = ObjC.UILabel.alloc().initWithFrame_([14, 12, 14, 20]);
    prompt.setAttributedText_(this.styled("›", "notice", 15));
    this.placeholder = ObjC.UILabel.alloc().initWithFrame_([33, 12, 300, 20]);  // UITextView has none of its own.
    this.placeholder.setAutoresizingMask_(2);  // Flexible width.
    for (const v of [prompt, this.placeholder]) this.field.addSubview_(v);
    this.setState(this.state);  // Sets the placeholder.

    this.spinner = ObjC.UIActivityIndicatorView.alloc().initWithActivityIndicatorStyle_(100);  // Medium.
    this.spinner.setColor_(COLORS.status);
    this.spinner.setHidesWhenStopped_(true);
    this.spinner.setContentCompressionResistancePriority_forAxis_(1000, 0);
    this.statusLabel = ObjC.UILabel.new();
    this.statusLabel.setLineBreakMode_(4);  // Truncate the tail.
    this.statusLabel.setContentHuggingPriority_forAxis_(1, 0);
    this.speedLabel = ObjC.UILabel.new();
    this.speedLabel.setContentCompressionResistancePriority_forAxis_(1000, 0);
    // Shown while a cell runs; see stopCell.
    this.stopButton = ObjC.UIButton.buttonWithType_(1);
    this.stopButton.setImage_forState_(ObjC.UIImage.systemImageNamed_("stop.circle.fill"), 0);
    this.stopButton.setTintColor_(COLORS.error);
    this.stopButton.setAccessibilityLabel_("Stop the running cell");
    this.stopButton.setContentCompressionResistancePriority_forAxis_(1000, 0);
    this.stopButton.setHidden_(true);
    this.stopTarget = ObjC.delegate({ stop: () => stopCell() });
    this.stopButton.addTarget_action_forControlEvents_(this.stopTarget, "stop", 64);  // Touch up inside.
    const status = ObjC.UIStackView.alloc().initWithArrangedSubviews_(
      [this.spinner, this.statusLabel, this.speedLabel, this.stopButton]);
    status.setSpacing_(6);

    for (const v of [this.log, this.field, status]) {
      v.setTranslatesAutoresizingMaskIntoConstraints_(false);
      view.addSubview_(v);
    }
    const safe = view.safeAreaLayoutGuide();
    ObjC.NSLayoutConstraint.activateConstraints_([
      this.log.topAnchor().constraintEqualToAnchor_(safe.topAnchor()),
      this.log.leadingAnchor().constraintEqualToAnchor_constant_(safe.leadingAnchor(), 12),
      this.log.trailingAnchor().constraintEqualToAnchor_constant_(safe.trailingAnchor(), -12),
      this.field.topAnchor().constraintEqualToAnchor_constant_(this.log.bottomAnchor(), 8),
      this.field.leadingAnchor().constraintEqualToAnchor_(this.log.leadingAnchor()),
      this.field.trailingAnchor().constraintEqualToAnchor_(this.log.trailingAnchor()),
      (this.fieldHeight = this.field.heightAnchor().constraintEqualToConstant_(44)),
      status.topAnchor().constraintEqualToAnchor_constant_(this.field.bottomAnchor(), 8),
      status.leadingAnchor().constraintEqualToAnchor_constant_(this.log.leadingAnchor(), 4),
      status.trailingAnchor().constraintEqualToAnchor_constant_(this.log.trailingAnchor(), -4),
      status.bottomAnchor().constraintEqualToAnchor_constant_(view.keyboardLayoutGuide().topAnchor(), -8),
    ]);
    this.fieldDelegate = ObjC.delegate({
      // Return sends; the field only takes text while a cell waits in input(), see setState.
      textView_shouldChangeTextInRange_replacementText_: (field, range, text) => {
        if (text !== "\n") return true;
        const message = field.text();
        if ((message.trim() || this.fallback !== null) && this.waiting.length) {
          field.setText_("");
          this.fit();
          this.submit(message);
        }
        return false;
      },
      textViewDidChange_: () => this.fit(),
    }, ["UITextViewDelegate"]);
    this.field.setDelegate_(this.fieldDelegate);
    this.showWelcome();
    this.window.makeKeyAndVisible();

    // A 48-point button in a 64-point window, so its shadow has room to show.
    // Starts above the tallest composer, so it never covers what the user types.
    this.handleWindow = ObjC.UIWindow.alloc().initWithWindowScene_(windowScene);
    this.handleWindow.setFrame_([screen[2] - 72, screen[3] - 300, 64, 64]);
    this.handleWindow.setWindowLevel_(2002);
    this.handleWindow.setRootViewController_(ObjC.UIViewController.new());
    const handle = ObjC.UIButton.buttonWithType_(0);  // Custom: the image keeps its own colors.
    handle.setFrame_([8, 8, 48, 48]);
    handle.setImage_forState_(ObjC.UIImage.imageNamed_("Handle"), 0);  // The app icon's spiral, from Assets.xcassets.
    handle.setAccessibilityLabel_(`${APP_NAME} console`);
    handle.imageView().layer().setCornerRadius_(24);  // Round the image, not the button, so the shadow is not clipped.
    handle.imageView().setClipsToBounds_(true);
    handle.layer().setShadowOpacity_(0.35);  // The default shadow color is black.
    handle.layer().setShadowRadius_(6);
    handle.layer().setShadowOffset_([0, 3]);
    // Tap to toggle the console, drag to move, hold to reset.
    this.handleTarget = ObjC.delegate({
      toggle: () => (this.window.isHidden() ? this.show() : this.hide()),
      drag_: (gesture) => this.drag(gesture),
      hold_: (gesture) => gesture.state() === 1 && this.confirmReset(),  // Began.
    });
    handle.addTarget_action_forControlEvents_(this.handleTarget, "toggle", 64);  // Touch up inside.
    handle.addGestureRecognizer_(ObjC.UIPanGestureRecognizer.alloc().initWithTarget_action_(this.handleTarget, "drag:"));
    handle.addGestureRecognizer_(ObjC.UILongPressGestureRecognizer.alloc().initWithTarget_action_(this.handleTarget, "hold:"));
    this.handleWindow.rootViewController().view().addSubview_(handle);
    this.handleWindow.setHidden_(false);

    this.timer = ObjC.NSTimer.scheduledTimerWithTimeInterval_repeats_block_(0.1, true, ObjC.block("v@", () => this.refresh()));
    // Leaving the app is the last sure chance to save: the system may end it in the background without a word.
    this.leaving = ObjC.block("v@", () => this.save());
    ObjC.NSNotificationCenter.defaultCenter().addObserverForName_object_queue_usingBlock_(
      "UIApplicationDidEnterBackgroundNotification", null, null, this.leaving);
  }

  styled(text, color = "text", size = 13, extra = {}) {
    return ObjC.NSAttributedString.alloc().initWithString_attributes_(text,
      { NSFont: mono(size), NSColor: COLORS[color], ...extra });
  }

  // What each kind of text adds to its color: cell output indents under its cell, the user's lines stand out bold.
  kindStyle(kind) {
    if (kind === "output") {
      const indent = ObjC.NSMutableParagraphStyle.new();
      indent.setFirstLineHeadIndent_(18);
      indent.setHeadIndent_(18);
      return { NSParagraphStyle: indent };
    }
    if (kind === "user") return { NSBackgroundColor: COLORS.composer, NSFont: mono(13, 0.4) };  // Bold.
    return {};
  }

  // Append to the conversation, following the end unless the user has scrolled up to read.
  // `kind` may also be attributes of the caller's own, which a later launch shows as plain text.
  append(text, color = "text", kind = "plain") {
    const storage = this.log.textStorage();
    if (this.welcome) {
      this.welcome = false;
      storage.deleteCharactersInRange_([0, storage.length()]);
    }
    const [, y] = this.log.contentOffset();
    const following = y + this.log.bounds()[3] >= this.log.contentSize()[1] - 40;
    const extra = typeof kind === "string" ? this.kindStyle(kind) : kind;
    storage.appendAttributedString_(this.styled(text, color, 13, extra));
    this.segments.push([text, color, typeof kind === "string" ? kind : "plain"]);
    this.unsaved = true;
    native.log(text);
    if (following) this.log.scrollRangeToVisible_([storage.length(), 0]);
  }

  // The conversation as the last launch left it, scrolled to its end. The window is laid out first, as it may be
  // hidden, and again when it shows, since it may not have its final size yet.
  restore(segments, ended) {
    let length = 0;
    const kept = segments.reverse().filter(([text]) => (length += text.length) <= TRANSCRIPT_LIMIT).reverse();
    // A cell the app ended while it ran never finished; its header stays, without the color of one that runs.
    for (const segment of kept) if (segment[1] === "cell" && segment[0].startsWith("● ")) segment[1] = "notice";
    const text = ObjC.NSMutableAttributedString.new();
    const styles = { plain: {}, output: this.kindStyle("output"), user: this.kindStyle("user") };
    for (const [part, color, kind] of kept) text.appendAttributedString_(this.styled(part, color, 13, styles[kind] ?? {}));
    this.log.setAttributedText_(text);
    Object.assign(this, { welcome: false, segments: kept, ended, unsaved: true, scrollPending: true });
    this.scrollToEnd();
  }

  scrollToEnd() {
    this.window.rootViewController().view().layoutIfNeeded();
    this.log.scrollRangeToVisible_([this.log.textStorage().length(), 0]);
  }

  // Keep the conversation for the next launch. Fails while the phone is locked, and is tried again.
  // ponytail: rewritten whole each time, at most every 2 seconds while it changes.
  save() {
    if (!this.unsaved) return;
    this.savedAt = Date.now();
    files.createDirectoryAtPath_withIntermediateDirectories_attributes_error_(SUPPORT, true, null, null);
    const json = JSON.stringify({ segments: this.segments, ended: this.ended });
    if (ObjC.send(json, "writeToFile:atomically:encoding:error:", TRANSCRIPT, true, 4, null)) this.unsaved = false;
  }

  // Whether the run ended or goes on, for the next launch.
  setEnded(ended) {
    this.ended = ended;
    this.unsaved = true;
  }

  showWelcome() {
    const center = ObjC.NSMutableParagraphStyle.new();
    center.setAlignment_(1);
    const text = ObjC.NSMutableAttributedString.new();
    text.appendAttributedString_(this.styled("\n\n\n\n" + LOGO + "\n\n", "logo", 7.5, { NSParagraphStyle: center }));
    text.appendAttributedString_(this.styled("Enter a task to begin.", "notice", 13, { NSParagraphStyle: center }));
    this.log.setAttributedText_(text);
  }

  // Cell output, indented under its cell; `print` in cells.
  write(text) {
    this.append(text, "text", "output");
  }

  addCell(number, summary) {
    // One blank line. The end is read from the last segments: the whole text may be long.
    if (!this.welcome && !this.segments.slice(-2).map(([text]) => text).join("").endsWith("\n\n")) this.append("\n");
    const header = `● cell ${number} · ${summary}`;
    this.append(header + "\n", "cell");
    // Measured after appending, which may first clear the welcome text.
    this.currentCell = { at: this.log.textStorage().length() - header.length - 1, length: header.length,
      segment: this.segments.at(-1) };
    this.setState(`Running · cell ${number}`, summary);
  }

  finishCell(result) {
    const { at, length, segment } = this.currentCell;
    const storage = this.log.textStorage();
    const stopped = result.error === STOPPED;  // A stopped cell, marked ■ as in the terminal.
    const [mark, color] = stopped ? ["■", "notice"] : result.error ? ["✗", "error"] : ["✓", "cell"];
    if (result.error) storage.addAttribute_value_range_("NSColor", COLORS[color], [at, length]);
    storage.replaceCharactersInRange_withAttributedString_([at, 1], this.styled(mark, color));
    if (segment) {  // Missing if a cell replaced currentCell.
      segment[0] = mark + segment[0].slice(1);
      if (result.error) segment[1] = color;
      this.unsaved = true;
    }
    if (stopped) this.append("Stopped. Send a message to go on.\n", "notice");
    else if (result.error) this.append(result.error + "\n", "error");
    this.setState(result.quit ? "Ended" : "Ready");
  }

  setState(state, detail = "") {
    this.state = state;
    keepWorking(state, detail);
    this.started = Date.now();
    const waiting = state === "Waiting for input";
    this.field.setEditable_(waiting);  // While the agent works, nothing can be typed, not only sent.
    const placeholder = waiting ? `Message ${APP_NAME}…` : `${APP_NAME} is working…`;
    this.placeholder.setAttributedText_(this.styled(placeholder, "notice", 15));
  }

  // The composer's height follows its wrapped text, between one line and COMPOSER_MAX.
  fit() {
    const [, height] = this.field.sizeThatFits_([this.field.bounds()[2], 10000]);
    this.fieldHeight.setConstant_(Math.min(Math.max(height, 44), COMPOSER_MAX));
    this.field.setScrollEnabled_(height > COMPOSER_MAX);
    this.placeholder.setHidden_(this.field.text().length > 0);
  }

  // Model requests, reported by `request` as they stream.
  modelStarted() {
    this.modelRequests += 1;
    this.started = Date.now();
    if (!this.tokenSamples.length) this.tokenSamples.push([this.started, 0]);
  }

  modelTokens(count) {
    this.tokenSamples.push([Date.now(), this.tokenSamples.at(-1)[1] + count]);
  }

  modelEnded() {
    this.modelRequests -= 1;
  }

  // Ten times a second: the status line, its spinner, and tokens per second over the last 3 seconds.
  refresh() {
    const now = Date.now();
    while (this.tokenSamples.length > 1 && this.tokenSamples[1][0] < now - 3000) this.tokenSamples.shift();
    let speed = 0;
    if (this.tokenSamples.length > 1) {
      const [first, last] = [this.tokenSamples[0], this.tokenSamples.at(-1)];
      speed = (last[1] - first[1]) / Math.max(0.25, (last[0] - first[0]) / 1000);
    }
    const seconds = ((now - this.started) / 1000).toFixed(1);
    let state = this.state;
    const running = this.state.startsWith("Running");
    if (running && stop.requested) {
      state = "Stopping · when the cell next waits on the network";
    } else if (this.retryAt > now) {  // See request.
      state = `Rate limited · retrying in ${Math.ceil((this.retryAt - now) / 1000)}s`;
    } else if (this.modelRequests) {
      const streaming = this.tokenSamples.length && this.tokenSamples.at(-1)[0] > this.started;
      state = `${streaming ? "Generating" : "Thinking"} · ${seconds}s`;
    } else if (state.startsWith("Running")) {
      state += ` · ${seconds}s`;
    }
    this.statusLabel.setAttributedText_(this.styled(state, "status", 12));
    this.speedLabel.setAttributedText_(this.styled(`↓ ${speed.toFixed(0)} tok/s`, "speed", 12));
    const busy = this.modelRequests > 0 || this.state.startsWith("Running");
    if (busy !== this.spinner.isAnimating()) busy ? this.spinner.startAnimating() : this.spinner.stopAnimating();
    const canStop = running && !stop.requested;
    if (canStop === this.stopButton.isHidden()) this.stopButton.setHidden_(!canStop);
    if (this.unsaved && now - this.savedAt >= 2000) this.save();
  }

  // The next line the user sends; `input` in cells.
  // The host's setup can also take a `fallback` for an empty reply, and mask a `secret` reply once it is sent.
  input(prompt = "", { secret = false, fallback = null } = {}) {
    if (prompt) this.write(prompt.endsWith("\n") ? prompt : prompt + "\n");
    this.setState("Waiting for input");
    if (fallback !== null) this.placeholder.setAttributedText_(this.styled(`Return for ${fallback}`, "notice", 15));
    Object.assign(this, { secret, fallback });
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  submit(text) {
    if (!text.trim() && this.fallback !== null) text = this.fallback;
    const shown = this.secret ? "•".repeat(Math.min(text.length, 12)) : text;
    Object.assign(this, { secret: false, fallback: null });
    // Right under the question it answers, then a blank line.
    this.append(` › ${shown} \n`, "user", "user");
    this.append("\n");
    this.save();  // Kept even if the app ends before the reply.
    this.setState("Running");
    this.waiting.shift()(text);
  }

  // Move the floating button's window with the finger, then settle at the nearest side, inside the safe area.
  drag(gesture) {
    const screen = this.window.rootViewController().view();  // Full-screen and still, even while hidden.
    if (gesture.state() === 1) this.dragFrom = this.handleWindow.frame();
    const [dx, dy] = gesture.translationInView_(screen);
    const [x, y, w, h] = this.dragFrom;
    this.handleWindow.setFrame_([x + dx, y + dy, w, h]);
    if (gesture.state() < 3) return;  // Ended, cancelled or failed from here on.
    const [, , width, height] = ObjC.UIScreen.mainScreen().bounds();
    const [top, left, bottom, right] = screen.safeAreaInsets();
    const nx = x + dx + w / 2 < width / 2 ? left + 8 : width - right - w - 8;  // The window adds 8 around the button.
    const ny = Math.min(Math.max(y + dy, top), height - bottom - h);
    ObjC.UIView.animateWithDuration_animations_(0.25, ObjC.block("v", () => this.handleWindow.setFrame_([nx, ny, w, h])));
  }

  confirmReset() {
    this.show();
    const alert = ObjC.UIAlertController.alertControllerWithTitle_message_preferredStyle_(`Reset ${APP_NAME}?`,
      `This deletes everything ${APP_NAME} built and saved, then closes the app. Open it again to start fresh.`, 1);
    alert.addAction_(ObjC.UIAlertAction.actionWithTitle_style_handler_("Cancel", 1, null));
    alert.addAction_(ObjC.UIAlertAction.actionWithTitle_style_handler_("Reset", 2, ObjC.block("v@", () => resetApp())));
    this.window.rootViewController().presentViewController_animated_completion_(alert, true, null);
  }

  show() {
    this.window.makeKeyAndVisible();
    if (this.scrollPending) this.scrollToEnd();
    this.scrollPending = false;
  }

  hide() {
    this.window.setHidden_(true);
  }
}

// --- RUNTIME -------------------------------------------------------------------------------------------

globalThis.setTimeout = (fn, ms = 0, ...args) =>
  ObjC.NSTimer.scheduledTimerWithTimeInterval_repeats_block_(ms / 1000, false, ObjC.block("v@", () => fn(...args)));
globalThis.clearTimeout = (timer) => timer?.invalidate();

// Requests carry the model API key in a header, so neither session keeps anything on disk: a default session would
// store each request, header and all, in Library/Caches. What earlier builds stored there goes at every launch.
ObjC.NSURLCache.sharedURLCache().removeAllCachedResponses();
const session = ObjC.NSURLSession.sessionWithConfiguration_delegate_delegateQueue_(
  ObjC.NSURLSessionConfiguration.ephemeralSessionConfiguration(), null, ObjC.NSOperationQueue.mainQueue(),
);

// Stop, as the terminal's Ctrl+C upstream: the console's stop button ends the running cell. JavaScript cannot be
// interrupted, so the stop lands where the cell waits on the network: requests in flight fail with STOPPED, and so
// does every new one until the cell ends, which then counts as stopped. The run waits for the user's next message
// instead of repairing. ponytail: requests boot.js makes meanwhile, outside the cell, fail as well.
const STOPPED = "Stopped by the user.";
const stop = { requested: false, inflight: new Set() };  // inflight: {task, reject} of each request a stop ends
function stopCell() {
  stop.requested = true;
  for (const r of stop.inflight) {
    r.reject(new Error(STOPPED));
    r.task.cancel();
  }
  stop.inflight.clear();
}
// Registers a request's task for a stop to cancel; returns false, having rejected, when a stop is pending.
function trackRequest(task, reject) {
  if (stop.requested) {
    reject(new Error(STOPPED));
    return null;
  }
  const entry = { task, reject };
  stop.inflight.add(entry);
  return entry;
}

globalThis.http = (url, { method = "GET", headers = {}, body = null } = {}) =>
  new Promise((resolve, reject) => {
    const request = ObjC.NSMutableURLRequest.requestWithURL_(ObjC.NSURL.URLWithString_(url));
    request.setHTTPMethod_(method);
    request.setTimeoutInterval_(600);
    for (const [k, v] of Object.entries(headers)) request.setValue_forHTTPHeaderField_(v, k);
    if (body !== null) request.setHTTPBody_(ObjC.send(body, "dataUsingEncoding:", 4));  // UTF-8
    let entry = null;
    const done = ObjC.block("v@@@", (data, response, error) => {
      stop.inflight.delete(entry);
      if (error) reject(new Error(error.localizedDescription()));
      else resolve({ status: response.statusCode(), text: ObjC.NSString.alloc().initWithData_encoding_(data, 4) });
    });
    const task = session.dataTaskWithRequest_completionHandler_(request, done);
    entry = trackRequest(task, reject);
    if (entry) task.resume();
  });

const files = ObjC.NSFileManager.defaultManager();
const DOCS = files.URLsForDirectory_inDomains_(9, 1)[0].path();  // Documents, user domain.

// While the agent works, the screen does not lock by itself, and from iOS 26 a continued processing task keeps the
// agent running after the user leaves the app, its progress shown by the system; both stop when it waits for input.
// The system may still end the task early, and a phone the user locks still keeps DOCS unreadable.
let backgroundTask = null;  // The task, once the system starts it; true while only requested.
let progress = { cell: 0, chunks: 0 };  // The running cell, and the chunks the model has streamed since.
// The system expires a task whose progress stalls, or is indeterminate, so it moves with every chunk received.
// ponytail: a run has no known length, so each cell is one step that the chunks fill without ever finishing.
function showProgress() {
  if (!backgroundTask?.progress) return;
  const { cell, chunks } = progress;
  backgroundTask.progress().setTotalUnitCount_((cell + 1) * 1000);
  backgroundTask.progress().setCompletedUnitCount_(cell * 1000 + Math.floor((999 * chunks) / (chunks + 200)));
}
function keepWorking(state, detail = "") {
  const working = state !== "Waiting for input";
  ObjC.UIApplication.sharedApplication().setIdleTimerDisabled_(working);
  if (!working) {
    if (backgroundTask?.setTaskCompletedWithSuccess_) backgroundTask.setTaskCompletedWithSuccess_(true);
    backgroundTask = null;
  } else if (state.startsWith("Running") && !backgroundTask && ObjC.BGContinuedProcessingTaskRequest) {
    const scheduler = ObjC.BGTaskScheduler.sharedScheduler();
    const id = ObjC.NSBundle.mainBundle().bundleIdentifier() + ".run." + Date.now();  // Matches Info.plist's ".run.*".
    backgroundTask = true;
    scheduler.registerForTaskWithIdentifier_usingQueue_launchHandler_(id, null, ObjC.block("v@", (task) => {
      if (backgroundTask !== true) return task.setTaskCompletedWithSuccess_(true);  // Waiting for input already.
      backgroundTask = task;
      showProgress();
      task.setExpirationHandler_(ObjC.block("v", () => {
        task.setTaskCompletedWithSuccess_(false);
        if (backgroundTask === task) backgroundTask = null;
      }));
    }));
    if (!scheduler.submitTaskRequest_error_(ObjC.BGContinuedProcessingTaskRequest.alloc()
      .initWithIdentifier_title_subtitle_(id, `${APP_NAME} is working`, state), null)) backgroundTask = null;
  }
  if (state.startsWith("Running · cell ")) {
    progress = { cell: Number(state.slice("Running · cell ".length)), chunks: 0 };
    showProgress();
  }
  // The title says which cell, the subtitle what it does.
  if (detail && backgroundTask?.updateTitle_subtitle_) {
    backgroundTask.updateTitle_subtitle_(`${APP_NAME} · ` + state.replace("Running · ", ""), detail);
  }
}
// What the app does outside cells, so the agent can see how what it built behaves in the user's hands: prints from
// callbacks and timers, callback errors, and how boot.js went. Only the newest APP_LOG_LIMIT lines are kept.
globalThis.app_log = [];
// URLs that opened the app, newest last, such as a widget region's; main.m calls openURL with each, including the
// one that launched it. Replace openURL to handle them as they come.
globalThis.opened_urls = [];
globalThis.openURL = (url) => opened_urls.push(url);
const APP_LOG_LIMIT = 500;
function logApp(text) {
  const time = new Date().toTimeString().slice(0, 8);
  for (const line of text.replace(/\n$/, "").split("\n")) app_log.push(`[${time}] ${line}`);
  app_log.splice(0, Math.max(0, app_log.length - APP_LOG_LIMIT));
}

// What is on screen now, every visible window back to front, as a PNG data URL. Scale 1 keeps it small for a model.
globalThis.screenshot = () => {
  const format = ObjC.UIGraphicsImageRendererFormat.preferredFormat();
  format.setScale_(1);
  const renderer = ObjC.UIGraphicsImageRenderer.alloc().initWithBounds_format_(ObjC.UIScreen.mainScreen().bounds(), format);
  const windows = ObjC.UIApplication.sharedApplication().windows().filter((w) => !w.isHidden());
  const png = renderer.PNGDataWithActions_(ObjC.block("v@", () => {
    for (const w of windows) w.drawViewHierarchyInRect_afterScreenUpdates_(w.frame(), true);
  }));
  return "data:image/png;base64," + png.base64EncodedStringWithOptions_(0);
};

const readText = (path) => ObjC.NSString.stringWithContentsOfFile_encoding_error_(path, 4, null);  // null if missing

// Every cell, as history records it, kept across launches. ponytail: a cell still running when iOS ends the app is
// lost; save it on UIApplicationWillTerminateNotification if that matters.
const HISTORY = DOCS + "/history.jsonl";
let unsavedCells = "";  // Lines not written yet, as while the phone is locked and DOCS is unreadable.
function saveCell(record) {
  unsavedCells += JSON.stringify(record) + "\n";
  try {
    if (!files.fileExistsAtPath_(HISTORY)) files.createFileAtPath_contents_attributes_(HISTORY, null, null);
    const handle = ObjC.NSFileHandle.fileHandleForWritingAtPath_(HISTORY);
    if (!handle) return;  // Tried again with the next cell.
    handle.seekToEndOfFile();
    handle.writeData_(ObjC.send(unsavedCells, "dataUsingEncoding:", 4));
    handle.closeFile();
    unsavedCells = "";
  } catch (e) {
    logApp(`Could not save to history.jsonl, kept for the next cell: ${e}`);
  }
}

// The records in HISTORY; a line that does not parse is left out.
function readHistory() {
  const records = [];
  for (const line of (readText(HISTORY) ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const { code = "", summary = "", output = "", error = null } = JSON.parse(line);
      records.push({ code, summary, output, error });
    } catch {}
  }
  return records;
}

// The console's conversation, kept across launches like the official app's, so a relaunch looks like none happened.
const SUPPORT = files.URLsForDirectory_inDomains_(14, 1)[0].path();  // Application Support; reset deletes it.
const TRANSCRIPT = SUPPORT + "/console.json";
const TRANSCRIPT_LIMIT = 2000000;  // Characters shown at launch, the newest; UITextView slows beyond.
const BOOTSTRAP_SUMMARY = "Run the bootstrap cell.";  // core.js's summary for a run's first cell.

// The conversation as the console showed it, rebuilt from HISTORY when there is no TRANSCRIPT yet.
// ponytail: the user's lines were not kept before TRANSCRIPT, so they are missing.
function historySegments(records) {
  const segments = [];
  let number = 0;
  for (const { summary, output, error } of records) {
    if (summary === BOOTSTRAP_SUMMARY) number = 0;
    if (segments.length && !segments.slice(-2).map(([text]) => text).join("").endsWith("\n\n")) {
      segments.push(["\n", "text", "plain"]);
    }
    segments.push([`${error ? "✗" : "✓"} cell ${number} · ${summary}\n`, error ? "error" : "cell", "plain"]);
    if (output) segments.push([output, "text", "output"]);
    if (error) segments.push([error + "\n", "error", "plain"]);
    number += 1;
  }
  return segments;
}

// The model settings, kept in the keychain by setup() at first launch rather than built into the app.
const SETTINGS = "model settings";  // Keychain: shell / terminal Agent channel.
const SETTINGS_APP = "model settings app";  // Keychain: App-side channel (Ideas, call_llm_api, …). #30
let CONFIG = JSON.parse(native.keychainGet(SETTINGS) ?? "null");  // {baseURL, apiKey, model, protocol?}
let CONFIG_APP = JSON.parse(native.keychainGet(SETTINGS_APP) ?? "null");  // null → fall back to CONFIG

// #30: protocol is "responses" (default) or "chat". Channel "shell" = Agent; "app" = call_llm_api / GUI helpers.
function configFor(channel = "shell") {
  if (channel === "app" && CONFIG_APP && CONFIG_APP.baseURL) return CONFIG_APP;
  return CONFIG;
}
function isCodexCfg(cfg) {
  return cfg?.apiKey === CODEX.marker;
}
const isCodex = () => isCodexCfg(CONFIG);

// One model request for the given channel. Streams; retries network drops and rate limits like before.
async function request(body, channel = "shell") {
  const cfg = configFor(channel);
  if (!cfg) throw new Error("Model is not configured.");
  const protocol = cfg.protocol === "chat" ? "chat" : "responses";
  for (let attempt = 1; ; attempt++) {
    try {
      if (protocol === "chat") {
        if (isCodexCfg(cfg)) throw new Error("ChatGPT 账号档案请使用 Responses 协议。");
        return await streamChat(body, cfg);
      }
      return await streamResponse(body, cfg, isCodexCfg(cfg) ? await codexToken() : null);
    } catch (e) {
      if (e.networkLost && attempt <= 3) {
        logApp(`Model request lost (${e.message}); sending it again, attempt ${attempt + 1}.`);
        await pause(2000 * attempt);
      } else if (e.rateLimited && attempt <= 4) {
        const ms = Math.min(60000, Math.max(e.retryAfter ?? 1, 1) * 1000 * 2 ** (attempt - 1));
        logApp(`Model request rate limited; sending it again in ${Math.round(ms / 1000)}s, attempt ${attempt + 1}.`);
        appConsole.retryAt = Date.now() + ms;
        try {
          await pause(ms);
        } finally {
          appConsole.retryAt = 0;
        }
      } else {
        throw e;
      }
    }
  }
}

// Waits ms, unless a stop comes first; see stopCell.
async function pause(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (stop.requested) throw new Error(STOPPED);
    await new Promise((done) => setTimeout(done, Math.min(250, until - Date.now())));
  }
  if (stop.requested) throw new Error(STOPPED);
}

// For an HTTP 429: whether waiting can help (not when the balance or budget is used up), and how long the provider
// asks to wait, in seconds, from Retry-After, X-RateLimit-Reset (seconds, or a Unix time) or the message.
function rateLimit(task, raw) {
  // Plan-usage and balance exhaustion: waiting will not help. App-specific ChatGPT limits use the same idea.
  if (/insufficient_quota|budget|balance|billing|credit|subscription_sharing_usage_limit/i.test(raw)
      && !/rate.?limit|RPM|TPM/i.test(raw)) return null;
  const header = (name) => {
    try {
      return Number(task.response().valueForHTTPHeaderField_(name)) || null;
    } catch {
      return null;
    }
  };
  let wait = header("Retry-After");
  const reset = header("X-RateLimit-Reset");
  if (wait == null && reset != null) wait = reset > 1e9 ? reset - Date.now() / 1000 : reset;
  if (wait == null) wait = Number(raw.match(/after (\d+(?:\.\d+)?) ?s/i)?.[1]) || null;
  return { retryAfter: wait == null ? null : Math.max(0, wait) };
}

// --- CHATGPT ACCOUNT -----------------------------------------------------------------------------------
// "Sign in with ChatGPT" for open-source apps (developers.openai.com/siwc/token-sharing-open-source): instead of an
// API key, the user signs in once; the app registers itself (dynamic client), keeps the issued client_id, and calls
// the public Responses API with the account's access token, which is refreshed before it ends. A profile whose API key
// is CODEX.marker uses it. The sign-in page shows in a web view; the redirect to the loopback callback, where no
// listener runs on a phone, is caught there instead.
const CODEX = { authorize: "https://auth.openai.com/api/accounts/authorize", token: "https://auth.openai.com/api/accounts/oauth/token",
  resource: "https://api.openai.com/v1", redirect: "http://127.0.0.1:1455/auth/callback", marker: "chatgpt-login",
  account: "chatgpt account", host: "chatgpt host id",  // Keychain accounts.
  scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" };
// Fields the ChatGPT plan route rejects (its "Preview limitations" page); dropped from each request.
const CODEX_UNSUPPORTED = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation",
  "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p",
  "truncation", "user", "previous_response_id"];

// Sign in with ChatGPT accepts function tools only inside a namespace or via `additional_tools`, not as bare
// top-level `tools` entries. Match Codex: put a `functions` namespace inside an `additional_tools` input item,
// and omit top-level `tools` entirely. See developers.openai.com/siwc/.../preview-limitations and Codex's
// Responses Lite serialization (namespace description must be non-empty).
function codexBody(body) {
  body = { ...body, store: false };
  CODEX_UNSUPPORTED.forEach((field) => delete body[field]);
  // Structured text formats (json_object / json_schema) are often rejected on this route.
  if (body.text?.format) delete body.text;
  // Plan usage has been returning completed responses with empty output when these are present with tools.
  delete body.include;
  delete body.reasoning;
  delete body.parallel_tool_calls;
  const tools = body.tools;
  if (!Array.isArray(tools) || !tools.length) { delete body.tools; return body; }
  const functions = [];
  for (const tool of tools) {
    if (tool?.type === "function" || (tool?.name && !tool.type)) {
      const fn = { ...tool, type: "function" };
      delete fn.strict;
      functions.push(fn);
    }
  }
  delete body.tools;  // Never send bare or mixed top-level tools on this route.
  if (!functions.length) return body;
  const input = Array.isArray(body.input) ? body.input : [];
  if (!input.some((item) => item && item.type === "additional_tools")) {
    body.input = [
      {
        type: "additional_tools",
        role: "developer",
        tools: [{
          type: "namespace",
          name: "functions",
          description: "Host tools for scheduling the next cell.",
          tools: functions,
        }],
      },
      ...input,
    ];
  }
  // Prefer an exact function force when waking the agent; "required" alone still yielded empty output[].
  if (body.tool_choice === "required" && functions.some((f) => f.name === "set_next_cell")) {
    body.tool_choice = { type: "function", name: "set_next_cell" };
  }
  return body;
}

// SHA-256 of a byte array, for the PKCE challenge; the bridge reaches no C hashing function.
function sha256(bytes) {
  const primes = [];
  for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
  const frac = (x) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
  const K = primes.map((p) => frac(Math.cbrt(p)));
  let H = primes.slice(0, 8).map((p) => frac(Math.sqrt(p)));
  const words = new Array(((bytes.length + 9 + 63) >> 6) << 4).fill(0);
  bytes.forEach((b, i) => { words[i >> 2] |= b << (24 - (i % 4) * 8); });
  words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
  words[words.length - 1] = bytes.length * 8;
  const r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < words.length; i += 16) {
    const w = words.slice(i, i + 16);
    for (let t = 16; t < 64; t++) {
      const [a, b] = [w[t - 15], w[t - 2]];
      w[t] = (w[t - 16] + (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) + w[t - 7] + (r(b, 17) ^ r(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    H = H.map((x, j) => (x + [a, b, c, d, e, f, g, h][j]) | 0);
  }
  return H.flatMap((x) => [x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255]);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const base64url = (bytes) => bytes.reduce((out, _, i) => {
  if (i % 3) return out;
  const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
  return out + [18, 12, 6, 0].slice(0, Math.min(4, bytes.length - i + 1)).map((s) => B64[(n >> s) & 63]).join("");
}, "");
// A JWT's claims; signatures are not checked here (the tokens come straight from the token endpoint over TLS).
function jwtClaims(token) {
  const part = String(token).split(".")[1] ?? "";
  let bits = 0, value = 0, bytes = [];
  for (const ch of part.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")) {
    value = (value << 6) | B64.indexOf(ch); bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 255); }
  }
  try { return JSON.parse(decodeURIComponent(bytes.map((b) => "%" + b.toString(16).padStart(2, "0")).join(""))); } catch { return {}; }
}
const randomString = () => [1, 2, 3].map(() => String(ObjC.NSUUID.UUID().UUIDString())).join("").replaceAll("-", "").toLowerCase();
const form = (fields) => Object.entries(fields).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
const codexSaved = () => JSON.parse(native.keychainGet(CODEX.account) ?? "null");

// Posts to the token endpoint and keeps the result, all fields replaced together.
async function codexTokens(fields, check = {}) {
  const { status, text } = await http(CODEX.token, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ resource: CODEX.resource, ...fields }) });
  const json = (() => { try { return JSON.parse(text); } catch { return {}; } })();
  if (status !== 200 || !json.access_token) throw new Error(`ChatGPT sign-in failed: HTTP ${status}: ${text.slice(0, 300)}`);
  const previous = codexSaved() ?? {};
  const id = json.id_token ? jwtClaims(json.id_token) : null;
  if (check.nonce && id) {
    const audience = [].concat(id.aud ?? []);
    if (id.nonce !== check.nonce || !audience.includes(fields.client_id) || id.exp * 1000 < Date.now())
      throw new Error("ChatGPT sign-in failed: the ID token does not match this sign-in.");
  }
  const scope = String(json.scope ?? previous.scope ?? "");
  if (!scope.split(" ").includes("chatgpt.tokens.use.direct"))
    throw new Error("ChatGPT sign-in did not grant plan usage (chatgpt.tokens.use.direct); this account or plan may not offer it.");
  const saved = { ...previous, clientId: fields.client_id, access: json.access_token, refresh: json.refresh_token ?? previous.refresh,
    expires: Date.now() + (json.expires_in ?? 3600) * 1000, scope, idToken: json.id_token ?? previous.idToken,
    subject: id?.sub ?? previous.subject, email: id?.email ?? previous.email };
  if (native.keychainSet(CODEX.account, JSON.stringify(saved)) !== 0) throw new Error("ChatGPT sign-in could not be saved in the Keychain.");
  return saved;
}

// The signed-in account's access token, refreshed when it ends within two minutes.
async function codexToken() {
  const saved = codexSaved();
  if (!saved?.refresh) throw new Error("No ChatGPT account is signed in; sign in from the model settings.");
  if (saved.expires - Date.now() > 120000) return saved;
  return codexTokens({ grant_type: "refresh_token", client_id: saved.clientId, refresh_token: saved.refresh });
}

// This phone's host id: one per host, kept before the first sign-in and reused.
function codexHost() {
  let id = native.keychainGet(CODEX.host);
  if (!id) { id = "urn:uuid:" + String(ObjC.NSUUID.UUID().UUIDString()).toLowerCase(); native.keychainSet(CODEX.host, id); }
  return id;
}

// Signs a ChatGPT account in; resolves to {email, model} once its tokens are in the Keychain. The first sign-in
// registers this app (client_id dynamic_agent_client) and keeps the issued client_id for later ones.
globalThis.codexLogin = async function codexLogin() {
  const previous = codexSaved(), returning = !!previous?.clientId;
  const verifier = randomString(), state = randomString().slice(0, 32), nonce = randomString().slice(0, 32);
  const url = CODEX.authorize + "?" + form({
    client_id: returning ? previous.clientId : "dynamic_agent_client",
    ...(returning ? {} : { agent_name_hint: APP_NAME }),
    ...(returning && previous.email ? { login_hint: previous.email } : {}),
    ext_agent_host_id: codexHost(), response_type: "code", redirect_uri: CODEX.redirect, scope: CODEX.scope,
    resource: CODEX.resource, state, nonce, code_challenge_method: "S256",
    code_challenge: base64url(sha256([...verifier].map((c) => c.charCodeAt(0)))) });
  const query = await new Promise((resolve, reject) => {
    const win = ObjC.UIWindow.alloc().initWithWindowScene_(appConsole.window.windowScene());
    win.setWindowLevel_(10);
    const vc = ObjC.UIViewController.new();
    win.setRootViewController_(vc);
    const root = vc.view(), [, , w, h] = root.bounds(), top = appConsole.window.safeAreaInsets()[0] || 59;
    root.setBackgroundColor_(ObjC.UIColor.systemBackgroundColor());
    const web = ObjC.WKWebView.alloc().initWithFrame_configuration_([0, top + 44, w, h - top - 44], ObjC.WKWebViewConfiguration.new());
    root.addSubview_(web);
    const cancel = ObjC.UIButton.buttonWithType_(1);
    cancel.setTitle_forState_("取消", 0);
    cancel.setFrame_([12, top, 80, 44]);
    root.addSubview_(cancel);
    const title = ObjC.UILabel.alloc().initWithFrame_([92, top, w - 184, 44]);
    title.setText_("登录 ChatGPT");
    title.setTextAlignment_(1);
    root.addSubview_(title);
    let ended = false;
    const end = (settle, value) => {
      if (ended) return;
      ended = true;
      web.stopLoading();
      win.setHidden_(true);
      setTimeout(() => { codexLogin.held = null; }, 1000);
      settle(value);
    };
    const check = (address) => {
      address = String(address ?? "");
      if (!address.startsWith(CODEX.redirect)) return;
      const q = Object.fromEntries((address.split("?")[1] ?? "").split("&").map((kv) => kv.split("=").map(decodeURIComponent)));
      if (q.state !== state) end(reject, new Error("ChatGPT sign-in did not finish: the reply does not match this sign-in."));
      else if (q.error || !q.code) end(reject, new Error("ChatGPT sign-in did not finish: " + (q.error_description || q.error || "no code")));
      else end(resolve, q);
    };
    const current = () => web.URL()?.absoluteString();
    const delegate = ObjC.delegate({
      webView_didStartProvisionalNavigation_: () => check(current()),
      webView_didReceiveServerRedirectForProvisionalNavigation_: () => check(current()),
      webView_didFailProvisionalNavigation_withError_: (view, nav, error) => check(error.userInfo()?.NSErrorFailingURLStringKey ?? current()),
      webView_didFinishNavigation_: () => check(current()),
    }, ["WKNavigationDelegate"]);
    const target = ObjC.delegate({ cancel: () => end(reject, new Error("ChatGPT sign-in was cancelled.")) });
    cancel.addTarget_action_forControlEvents_(target, "cancel", 64);
    codexLogin.held = { win, web, delegate, target };  // UIKit holds these weakly.
    web.setNavigationDelegate_(delegate);
    web.loadRequest_(ObjC.NSURLRequest.requestWithURL_(ObjC.NSURL.URLWithString_(url)));
    win.makeKeyAndVisible();
  });
  // A first sign-in returns the issued client_id; a returning one must keep its own.
  const clientId = returning ? previous.clientId : query.client_id;
  if (!clientId || clientId === "dynamic_agent_client" || (returning && query.client_id && query.client_id !== clientId))
    throw new Error("ChatGPT sign-in did not finish: no client was registered for this app.");
  const saved = await codexTokens({ grant_type: "authorization_code", client_id: clientId, code: query.code,
    code_verifier: verifier, redirect_uri: CODEX.redirect }, { nonce });
  // A model the account may use: the first listed one.
  let model = null;
  try {
    const { status, text } = await http(CODEX.resource + "/models", { headers: { Authorization: "Bearer " + saved.access } });
    const list = status === 200 ? (JSON.parse(text).models ?? []) : [];
    model = (list.find((m) => m.visibility === "list") ?? list[0])?.slug ?? null;
  } catch {}
  return { email: saved.email ?? null, model, base: CODEX.resource, key: CODEX.marker };
};

// NSURLErrorDomain codes for a connection that failed or dropped: timed out, cannot connect, connection lost, offline.
const NETWORK_LOST = [-1001, -1004, -1005, -1009];

function streamResponse(body, cfg, codex = null) {
  return new Promise((resolve, reject) => {
    const req = ObjC.NSMutableURLRequest.requestWithURL_(ObjC.NSURL.URLWithString_(cfg.baseURL + "/responses"));
    req.setHTTPMethod_("POST");
    req.setTimeoutInterval_(600);
    req.setValue_forHTTPHeaderField_("application/json", "Content-Type");
    req.setValue_forHTTPHeaderField_("Bearer " + (codex ? codex.access : cfg.apiKey), "Authorization");
    if (codex) body = codexBody(body);  // ChatGPT plan usage: strip rejected fields; namespace function tools.
    req.setHTTPBody_(ObjC.send(JSON.stringify({ model: cfg.model, ...body, stream: true }), "dataUsingEncoding:", 4));

    const pending = ObjC.NSMutableData.new();  // Bytes not yet decoded: a chunk can end inside a UTF-8 character.
    let buffer = "";  // Text not yet split into server-sent events.
    let raw = "";  // Everything received, for errors that are not events.
    let settled = false;
    let entry = null;  // For a stop to end this request; see stopCell.
    // ChatGPT plan / Responses Lite often sends output items only as stream events; response.completed then
    // arrives with output:[]. Rebuild from output_item.done (and argument finals) so set_next_cell is visible.
    const streamed = [];  // sparse by output_index
    const putItem = (index, item) => {
      if (index == null || !item) return;
      streamed[index] = item;
    };
    const streamedOutput = () => streamed.filter(Boolean);
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      stop.inflight.delete(entry);
      appConsole.modelEnded();
      fn(value);
    };
    const failResponse = (err) => {
      const code = err?.code ? ` [${err.code}]` : "";
      const msg = err?.message ?? (typeof err === "string" ? err : null) ?? JSON.stringify(err ?? "Model request failed.");
      return new Error(msg + code);
    };
    const finish = (response, ok) => {
      response = response ?? {};
      if (!(response.output && response.output.length) && streamedOutput().length) {
        response.output = streamedOutput();
      }
      response = withOutputText(response);
      if (codex) {
        const kinds = (response.output ?? []).map((o) => o.type + (o.name ? ":" + o.name : ""));
        logApp(`chatgpt ${ok ? "completed" : "incomplete"} status=${response.status} output=[${kinds.join(", ")}] `
          + `text=${JSON.stringify((response.output_text || "").slice(0, 120))}`);
      }
      if (ok) settle(resolve, response);
      else {
        const reason = response.incomplete_details?.reason ?? "incomplete";
        const text = (response.output_text || "").trim();
        settle(reject, new Error(`Model response incomplete (${reason})${text ? ": " + text.slice(0, 500) : ""}`));
      }
    };
    const handle = (event) => {
      const data = event.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data || data === "[DONE]") return;
      const e = JSON.parse(data);
      if (e.type?.endsWith(".delta") && typeof e.delta === "string") {
        appConsole.modelTokens(encodeURIComponent(e.delta).replace(/%../g, "x").length / 4);  // UTF-8 bytes / 4
      } else if (e.type === "response.output_item.added" || e.type === "response.output_item.done") {
        putItem(e.output_index, e.item);
      } else if (e.type === "response.function_call_arguments.done") {
        const item = streamed[e.output_index] ?? { type: "function_call", id: e.item_id };
        item.arguments = e.arguments ?? item.arguments;
        if (e.item_id) item.id = item.id ?? e.item_id;
        putItem(e.output_index, item);
      } else if (e.type === "response.completed") {
        finish(e.response ?? {}, true);
      } else if (e.type === "response.incomplete") {
        finish(e.response ?? {}, false);
      } else if (e.type === "response.failed") {
        settle(reject, failResponse(e.response?.error));
      } else if (e.type === "error") {
        settle(reject, failResponse(e.error ?? e));
      }
    };
    const delegate = ObjC.delegate({
      URLSession_dataTask_didReceiveData_: (session, task, data) => {
        progress.chunks += 1;  // Keep-alive comments too, which arrive while the model reasons.
        showProgress();
        pending.appendData_(data);
        const text = ObjC.NSString.alloc().initWithData_encoding_(pending, 4);
        if (text == null) return;  // Wait for the rest of a split character.
        pending.setLength_(0);
        raw += text;
        buffer += text.replaceAll("\r", "");
        const events = buffer.split("\n\n");
        buffer = events.pop();
        events.forEach(handle);
      },
      URLSession_task_didCompleteWithError_: (session, task, error) => {
        const status = task.response()?.statusCode();
        if (error) {
          const lost = Object.assign(new Error(`${error.localizedDescription()} (${error.domain()} ${error.code()})`), {
            networkLost: error.domain() === "NSURLErrorDomain" && NETWORK_LOST.includes(error.code()),
          });
          settle(reject, lost);
        }
        else if (status !== 200) {
          const limited = status === 429 ? rateLimit(task, raw) : null;
          settle(reject, Object.assign(new Error(`Model request failed: HTTP ${status}: ${raw}`),
            limited ? { rateLimited: true, retryAfter: limited.retryAfter } : {}));
        }
        else settle(reject, new Error("Model stream ended without a final response."));
      },
    }, ["NSURLSessionDataDelegate"]);
    // The session holds the delegate until its task ends. Without a network, the task waits for one instead of failing.
    const config = ObjC.NSURLSessionConfiguration.ephemeralSessionConfiguration();
    config.setWaitsForConnectivity_(true);
    const session = ObjC.NSURLSession.sessionWithConfiguration_delegate_delegateQueue_(
      config, delegate, ObjC.NSOperationQueue.mainQueue());
    appConsole.modelStarted();
    const task = session.dataTaskWithRequest_(req);
    entry = trackRequest(task, (e) => settle(reject, e));
    if (entry) task.resume();
    session.finishTasksAndInvalidate();
  });
}

// #30 Chat Completions: enough for call_llm_api / Ideas (text + optional json_object). Agent tool loop stays on Responses for now.
function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (p?.text ?? p?.content ?? ""))).join("");
  return String(content);
}
function responsesInputToChatMessages(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  const input = body.input;
  if (typeof input === "string") messages.push({ role: "user", content: input });
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      if (item.role && item.content != null) {
        const role = item.role === "assistant" || item.role === "system" || item.role === "tool" ? item.role : "user";
        messages.push({ role, content: contentText(item.content) });
      } else if (item.type === "message" && item.content != null) {
        const role = item.role === "assistant" || item.role === "system" ? item.role : "user";
        messages.push({ role, content: contentText(item.content) });
      }
      // function_call / reasoning etc. skipped in phase 1
    }
  }
  if (!messages.length) messages.push({ role: "user", content: "" });
  return messages;
}
function responsesBodyToChat(body, cfg) {
  const out = { model: body.model || cfg.model, messages: responsesInputToChatMessages(body), stream: true };
  if (body.text?.format?.type === "json_object") out.response_format = { type: "json_object" };
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  return out;
}
function chatResponseFromText(text) {
  const output_text = String(text || "");
  return withOutputText({
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: output_text }] }],
  });
}
function streamChat(body, cfg) {
  return new Promise((resolve, reject) => {
    const payload = responsesBodyToChat(body, cfg);
    const req = ObjC.NSMutableURLRequest.requestWithURL_(ObjC.NSURL.URLWithString_(cfg.baseURL + "/chat/completions"));
    req.setHTTPMethod_("POST");
    req.setTimeoutInterval_(600);
    req.setValue_forHTTPHeaderField_("application/json", "Content-Type");
    req.setValue_forHTTPHeaderField_("Bearer " + cfg.apiKey, "Authorization");
    req.setHTTPBody_(ObjC.send(JSON.stringify(payload), "dataUsingEncoding:", 4));

    const pending = ObjC.NSMutableData.new();
    let buffer = "", raw = "", full = "", settled = false, entry = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      stop.inflight.delete(entry);
      appConsole.modelEnded();
      fn(value);
    };
    const handle = (event) => {
      const data = event.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data || data === "[DONE]") return;
      let e;
      try { e = JSON.parse(data); } catch { return; }
      if (e.error) {
        settle(reject, new Error(e.error.message ?? JSON.stringify(e.error)));
        return;
      }
      const choice = e.choices && e.choices[0];
      const delta = choice && (choice.delta?.content ?? choice.message?.content);
      if (typeof delta === "string" && delta) {
        full += delta;
        appConsole.modelTokens(encodeURIComponent(delta).replace(/%../g, "x").length / 4);
      }
    };
    const delegate = ObjC.delegate({
      URLSession_dataTask_didReceiveData_: (session, task, data) => {
        progress.chunks += 1;
        showProgress();
        pending.appendData_(data);
        const text = ObjC.NSString.alloc().initWithData_encoding_(pending, 4);
        if (text == null) return;
        pending.setLength_(0);
        raw += text;
        buffer += text.replaceAll("\r", "");
        const events = buffer.split("\n\n");
        buffer = events.pop();
        events.forEach(handle);
      },
      URLSession_task_didCompleteWithError_: (session, task, error) => {
        const status = task.response()?.statusCode();
        if (error) {
          const lost = Object.assign(new Error(`${error.localizedDescription()} (${error.domain()} ${error.code()})`), {
            networkLost: error.domain() === "NSURLErrorDomain" && NETWORK_LOST.includes(error.code()),
          });
          settle(reject, lost);
        } else if (status !== 200) {
          const limited = status === 429 ? rateLimit(task, raw) : null;
          settle(reject, Object.assign(new Error(`Model request failed: HTTP ${status}: ${raw}`),
            limited ? { rateLimited: true, retryAfter: limited.retryAfter } : {}));
        } else if (full) {
          settle(resolve, chatResponseFromText(full));
        } else {
          // Some gateways return a single JSON object instead of SSE.
          try {
            const j = JSON.parse(raw);
            const t = j.choices?.[0]?.message?.content;
            if (typeof t === "string") settle(resolve, chatResponseFromText(t));
            else settle(reject, new Error("Chat stream ended without content."));
          } catch {
            settle(reject, new Error("Chat stream ended without content."));
          }
        }
      },
    }, ["NSURLSessionDataDelegate"]);
    const config = ObjC.NSURLSessionConfiguration.ephemeralSessionConfiguration();
    config.setWaitsForConnectivity_(true);
    const session = ObjC.NSURLSession.sessionWithConfiguration_delegate_delegateQueue_(
      config, delegate, ObjC.NSOperationQueue.mainQueue());
    appConsole.modelStarted();
    const task = session.dataTaskWithRequest_(req);
    entry = trackRequest(task, (e) => settle(reject, e));
    if (entry) task.resume();
    session.finishTasksAndInvalidate();
  });
}

function withOutputText(response) {
  response.output_text = (response.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text").map((c) => c.text).join("");
  return response;
}

// --- BOOTSTRAP -----------------------------------------------------------------------------------------

// Read the user's task, set up working state and context helpers, then wake the mind. The helpers live in the
// session, not here, so later cells can replace them; see bootstraps/terminal/context.py. The function's body is
// sent as the bootstrap cell and it is never called directly.
async function bootstrapCell() {
  task = await input();
  instructions = `
Your working instructions, variables() and build_context() are JavaScript state in this session.
Their original implementation is the bootstrap cell in source_code['app.js']; you can replace them in later cells.
source_code also contains the core runtime source. Read relevant excerpts and include them in input when needed.
Use await call_me([...build_context(), {role: "user", content: observations}]) to send these instructions and your selected context.
Keep useful data and task-specific helpers in session variables; update var_docs to describe them.
startup_task preserves the initial task. Maintain task_state before each call_me():
update goal and constraints when the user steers the task, and completed and pending as work progresses.
Record verified outcomes in completed; planned work belongs in pending. build_context() carries all fields on every call.
History summaries record intent; use cell output and errors to determine what actually happened.
`.trim();
  startup_task = task;
  task_state = { goal: task, constraints: [], completed: [], pending: [] };
  source_code = { ...globalThis.source_code, ...SOURCE_CODE };
  RECENT = globalThis.RECENT ?? 10;
  var_docs = {
    ...globalThis.var_docs,
    startup_task: "Original task; preserve when the current goal changes.",
    task_state: "Current goal, constraints, verified completed work and pending work; update before call_me().",
  };

  // Select names and types from the live session; cells may replace this policy.
  variables = () => {
    const found = {};
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (name.startsWith("_") || HOST_NAMES.has(name) || EXCLUDED_NAMES.has(name)) continue;
      const value = globalThis[name];
      found[name] = Array.isArray(value) ? `Array[${value.length}]` : typeof value;
    }
    return found;
  };

  // Select context from current session variables and the host's refreshed history; cells may replace this.
  build_context = () => {
    const described = Object.entries(variables()).map(([name, kind]) =>
      `${name}: ${kind}` + (var_docs[name] ? ` (${var_docs[name]})` : ""));
    const lines = [
      "Startup task: " + startup_task,
      "Current goal: " + task_state.goal,
      "Constraints: " + JSON.stringify(task_state.constraints),
      "Completed: " + JSON.stringify(task_state.completed),
      "Pending: " + JSON.stringify(task_state.pending),
      "Documents directory: " + DOCS,
      "Current task cell: " + history.length,
      "Variables: " + (described.slice(0, 200).join(", ") || "none"),
      "App log outside cells (newest last; all of it in app_log): " + (app_log.slice(-20).join("\n") || "none"),
    ];
    // Older records stay accessible by index; summarize their intent and outcome here.
    const start = Math.max(0, history.length - RECENT);
    history.slice(0, start).forEach((cell, number) => {
      lines.push(`cell ${number}: ${cell.summary} [${cell.error ? "failed: " + cell.error.split("\n")[0] : "ok"}]`);
    });
    const blocks = history.slice(start).map((cell, i) => {
      const number = start + i;
      const parts = [`### cell ${number} · ${cell.summary}`, "code:", cell.code.trim()];
      let output = cell.output.trim();
      if (output.length > 1000) output = output.slice(0, 500) + `\n[Full output: history[${number}].output]\n` + output.slice(-500);
      if (output) parts.push("output:", output);
      if (cell.error) parts.push("error:", cell.error.trim());
      return parts.join("\n");
    });
    const context = [...lines, "Recent task cells:", blocks.join("\n\n") || "none yet"].join("\n");
    return [{ role: "developer", content: instructions }, { role: "user", content: context }];
  };

  await call_me([...build_context(), { role: "user", content: "Start the user's task and submit the next JavaScript cell." }]);
}

const BOOTSTRAP = bootstrapCell.toString().replace(/^[^{]*\{\n/, "").replace(/\}\s*$/, "").replace(/^ {2}/gm, "").trim();
const bundled = (name, type = "js") => readText(ObjC.NSBundle.mainBundle().pathForResource_ofType_(name, type));
const SOURCE_CODE = { "core.js": bundled("core"), "app.js": bundled("app"), "FBWidget.swift": bundled("FBWidget", "swift"),
  "widget/Widget.swift": bundled("Widget", "swift") };
const EXCLUDED_NAMES = new Set(["task", "call_me", "call_llm_api", "quit", "history", "input", "source_code"]);

// --- MAIN ----------------------------------------------------------------------------------------------

const appConsole = new Console();
const consoleWindow = appConsole.window;
let quietBoot = false;  // boot.js prints only to app_log, so a restored conversation goes on as it was.
const env = new JSEnv({
  write: (text) => {
    if (env.capture === null || callbackDepth > 0) logApp(text);  // The app's own output, not a cell's.
    if (!quietBoot) appConsole.write(text);
  },
  readInput: (prompt) => appConsole.input(prompt),
});
const mind = new Mind((body) => request(body, "shell"), INSTRUCTIONS + "\n\n\n" + IPHONE);
const agent = new Agent(mind);
const appMind = new Mind((body) => request(body, "app"), "");  // #30: App channel (Ideas / helpers)
env.bind({ call_llm_api: (input, params) => appMind.query(input, params) });  // boot.js may use it before the agent runs.
const HOST_NAMES = new Set(Object.getOwnPropertyNames(globalThis));  // Hidden from variables().

const defaults = ObjC.NSUserDefaults.standardUserDefaults();
const BOOT = DOCS + "/boot.js";
const FAILURES = "fibona.bootFailures";

// Back to the first launch: delete what the agent built and saved (files and settings), then end the process, and the
// session with it. Permissions the user granted stay with iOS until the app is deleted. Only the user starts this.
function resetApp() {
  const widget = ObjC.FBWidget.directory();
  if (widget && !files.removeItemAtPath_error_(widget, null))
    return env.write("Reset failed: could not delete widget data. Try again.\n");
  ObjC.FBWidget.reload();
  const library = files.URLsForDirectory_inDomains_(5, 1)[0].path();  // Library, user domain.
  for (const dir of [DOCS, library, files.temporaryDirectory().path()]) {
    for (const name of files.contentsOfDirectoryAtPath_error_(dir, null) ?? []) {
      if (dir !== library || name !== "Preferences") files.removeItemAtPath_error_(dir + "/" + name, null);
    }
  }
  defaults.removePersistentDomainForName_(ObjC.NSBundle.mainBundle().bundleIdentifier());
  native.keychainSet(SETTINGS, null);
  native.keychainSet(SETTINGS_APP, null);
  CONFIG_APP = null;
  defaults.synchronize();
  try {
    ObjC.UIApplication.sharedApplication().performSelector_("terminateWithSuccess");  // Private; there is no public way.
  } catch {
    env.write(`Reset done. Close ${APP_NAME} and open it again.\n`);
  }
}

// Run boot.js, counting launches it fails to survive; after 3 in a row, set it aside.
async function boot() {
  const code = readText(BOOT);
  const failures = defaults.integerForKey_(FAILURES);
  if (!code) return;
  if (failures >= 3) {
    files.removeItemAtPath_error_(DOCS + "/boot.failed.js", null);
    if (!files.moveItemAtPath_toPath_error_(BOOT, DOCS + "/boot.failed.js", null))
      return env.write("Safe mode: could not move boot.js to boot.failed.js; boot.js was skipped.\n");
    defaults.setInteger_forKey_(0, FAILURES);
    return env.write(`Safe mode: boot.js failed to start ${failures} times in a row and was moved to boot.failed.js.\n`);
  }
  // Counted before it runs and saved now, so a crash still counts; cleared once it has run for a while.
  defaults.setInteger_forKey_(failures + 1, FAILURES);
  defaults.synchronize();
  quietBoot = !appConsole.welcome;
  const result = await env.execute(code);
  quietBoot = false;
  logApp(`boot.js ${result.error ? "failed" : "ran"}\n${result.output}${result.error ?? ""}`);
  if (result.error) return env.write(`boot.js failed:\n${result.error}\n`);
  appConsole.hide();
  setTimeout(() => defaults.setInteger_forKey_(0, FAILURES), 10000);
}

// First launch: ask for the model settings in the console, check them with one small request, and keep them in the
// keychain. Asks again until a request works. Reset deletes them.
async function setup() {
  env.write(`${APP_NAME} needs a model API to think with. It asks once and keeps the answers in this phone's keychain.\n\n`);
  while (true) {
    const baseURL = (await appConsole.input("Model API base URL")).trim();
    const apiKey = (await appConsole.input("API key", { secret: true })).trim();
    const model = (await appConsole.input("Model", { fallback: "gpt-6-astra" })).trim();
    CONFIG = { baseURL: baseURL.replace(/\/+$/, ""), apiKey, model };
    env.write("Checking…\n");
    try {
      await mind.query("Reply with OK.", { max_output_tokens: 16 });
    } catch (e) {
      env.write(`That did not work: ${e.message}\nLet's try again.\n`);
      continue;
    }
    const status = native.keychainSet(SETTINGS, JSON.stringify(CONFIG));
    env.write(status === 0 ? "Saved.\n" : `Could not save to the keychain (error ${status}), so they last until the app closes.\n`);
    return;
  }
}

// Makes core's repair cell after a stopped cell wait for the user, then wake the mind with the usual context and
// their message, as the terminal bootstrap does upstream. Core binds call_me just before onCell, so it is replaced here.
function waitAfterStop(number) {
  const wake = globalThis.call_me;
  globalThis.call_me = async (input, body) => {
    const message = await appConsole.input();
    const note = `The user stopped cell ${number} partway; its side effects are not rolled back (record in history, `
      + `state in globals()). Their message:\n\n${message}`;
    const context = typeof globalThis.build_context === "function" ? globalThis.build_context() : [];
    return wake([...context, { role: "user", content: note }], body);
  };
}

// The agent reads each task with input(); when a run ends, a new one waits for the next message.
let runningCell = null;  // The running cell's code and summary, for its line in HISTORY.
// A relaunch shows the conversation as it was and continues the run it ended: the run's cells since its bootstrap
// cell are its history again, and a bootstrap cell that shows nothing waits for the next message.
async function main() {
  const records = readHistory();
  let kept = null;
  try {
    kept = JSON.parse(readText(TRANSCRIPT) ?? "null");
  } catch (e) {
    logApp(`Could not read ${TRANSCRIPT}, rebuilt from history: ${e}`);
  }
  if (!kept && records.length) kept = { segments: historySegments(records), ended: false };
  if (kept) appConsole.restore(kept.segments, kept.ended);
  const start = records.findLastIndex((record) => record.summary === BOOTSTRAP_SUMMARY);
  let resumed = kept && !kept.ended && start >= 0 ? records.slice(start) : [];
  if (!CONFIG) await setup();
  await boot();
  while (true) {
    let hidden = resumed.length > 0;  // The resumed run's bootstrap cell, shown only if it fails.
    let stopped = false;  // Whether the last cell was stopped, so core's repair cell waits for the user instead.
    appConsole.setEnded(false);
    await agent.run(BOOTSTRAP, {
      env,
      history: resumed,
      onCell: (number, summary, code) => {
        if (stopped && summary === Agent.REPAIR_SUMMARY) {
          waitAfterStop(number - 1);
          summary = "Wait for the user's message after the stop.";
        }
        stopped = false;
        runningCell = { code, summary };
        if (!hidden) appConsole.addCell(number, summary);
      },
      onResult: (number, result) => {
        // A cell that ends while a stop is pending was stopped, even if it caught the error and went on.
        if (stop.requested) {
          stop.requested = false;
          if (!result.quit) [result.error, stopped] = [STOPPED, true];
        }
        if (hidden) {
          hidden = false;
          if (!result.error) return;  // Not one of the run's cells, so not in HISTORY either.
          appConsole.addCell(number, runningCell.summary);
        } else {
          saveCell({ ...runningCell, output: result.output, error: result.error });
        }
        appConsole.finishCell(result);
      },
    });
    resumed = [];
    appConsole.setEnded(true);
    env.write("The run ended. Send a message to start a new one.\n");
  }
}

main().catch((e) => env.write(`${APP_NAME} stopped: ${e}\n${e?.stack ?? ""}\n`));
