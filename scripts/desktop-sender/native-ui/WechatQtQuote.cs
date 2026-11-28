using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

internal static partial class WechatDraftProbe
{
    sealed class QtQuoteSelection
    {
        internal string Token, Text, Page, Preview;
        internal QtQuotePattern Pattern;
        internal QtTextStepBinding Step;
        internal long Revision;
        internal Binding Binding;
    }
    static QtQuoteSelection QtActiveQuote;
    static bool QtQuoteMenuRootShape(string className, ControlType type)
    {
        return className == "mmui::XMenu" && type == ControlType.Window;
    }
    sealed class QtQuoteRowKey
    {
        internal string Kind, Text;
    }
    sealed class QtQuotePattern
    {
        internal QtQuoteRowKey[] Rows;
        internal int Index;
        internal QtQuoteRowKey Target
        {
            get {
                return Rows[Index];
            }
        }
    }
    static bool QtTitledQuoteKind(string kind)
    {
        return kind == "text" || kind == "link" || kind == "record" || kind == "file" || kind == "card" ||
               kind == "quote";
    }
    static QtQuotePattern QtQuoteRequestPattern(Dictionary<string, object> request, string text)
    {
        if (!request.ContainsKey("quoteLocator") && !request.ContainsKey("quoteKind"))
            return null;
        var locator = Map(Get(request, "quoteLocator"));
        Need(locator != null, "QT_QUOTE_REQUEST_INVALID");
        var rows = Get(locator, "rows") as object[];
        long index = Number(Get(locator, "index"));
        Need(rows != null && rows.Length > 0 && rows.Length <= 7 && index >= 0 && index < rows.Length,
             "QT_QUOTE_REQUEST_INVALID");
        var pattern = new QtQuotePattern { Rows = new QtQuoteRowKey[rows.Length], Index = (int)index };
        for (int i = 0; i < rows.Length; i++)
        {
            var key = Map(rows[i]);
            Need(key != null, "QT_QUOTE_REQUEST_INVALID");
            string kind = Text(key, "kind"), title = Text(key, "text");
            bool titled = QtTitledQuoteKind(kind);
            Need(titled || kind == "image" || kind == "voice" || kind == "sticker" || kind == "video",
                 "QT_QUOTE_REQUEST_INVALID");
            Need(titled ? !String.IsNullOrEmpty(title) && title.Length <= 4096 : title == null,
                 "QT_QUOTE_REQUEST_INVALID");
            pattern.Rows[i] = new QtQuoteRowKey { Kind = kind, Text = title };
        }
        Need(pattern.Target.Kind == Text(request, "quoteKind") && pattern.Target.Kind != "text" &&
                 (pattern.Target.Text == null || pattern.Target.Text == text),
             "QT_QUOTE_REQUEST_INVALID");
        return pattern;
    }
    static string QtQuoteClassKind(string cls)
    {
        switch (cls)
        {
        case "mmui::ChatTextItemView":
            return "text";
        case "mmui::ChatImageItemView":
            return "image";
        case "mmui::ChatVoiceItemView":
        case "mmui::ChatAudioItemView":
            return "voice";
        case "mmui::ChatVideoItemView":
            return "video";
        case "mmui::ChatEmotionItemView":
        case "mmui::ChatEmojiItemView":
        case "mmui::ChatStickerItemView":
            return "sticker";
        case "mmui::ChatBubbleReferItemView":
            return "quote";
        case "mmui::ChatBubbleItemView":
        case "mmui::ChatPersonalCardItemView":
        case "mmui::ChatFileItemView":
        case "mmui::ChatLinkItemView":
        case "mmui::ChatLocationItemView":
            return "card";
        default:
            return "";
        }
    }
    static bool QtQuoteCardKind(string kind)
    {
        return kind == "link" || kind == "record" || kind == "file" || kind == "card";
    }
    static bool QtQuoteTimeDivider(string cls, string name)
    {
        return cls == "mmui::ChatItemView" && name != null && name.Length <= 50 &&
               System.Text.RegularExpressions.Regex.IsMatch(
                   name,
                   @"^(?:(?:今天|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|(?:\d{4}年)?\d{1,2}月\d{1,2}" +
                       @"日|\d{2,4}[-/]\d{1,2}[-/]\d{1,4})\s*)?(?:上午|下午|晚上)?\s*(?:[01]?\d|2[0-3]):[0-5]\d$");
    }
    static string[] QtQuoteTypeLabels(string kind)
    {
        switch (kind)
        {
        case "image":
            return new[] { "图片", "圖片", "Photo", "Image" };
        case "voice":
            return new[] { "语音", "語音", "Voice", "Audio" };
        case "sticker":
            return new[] { "表情", "动画表情", "動畫表情", "Sticker" };
        case "video":
            return new[] { "视频", "影片", "Video" };
        case "record":
            return new[] { "聊天记录", "聊天記錄", "Chat History" };
        case "file":
            return new[] { "文件", "檔案", "File" };
        case "link":
            return new[] { "链接", "連結", "Link" };
        case "card":
            return new[] { "名片", "位置", "小程序", "Contact Card", "Location", "Mini Program" };
        default:
            return new string[0];
        }
    }
    static bool QtQuoteNamedRow(QtQuoteRowKey key, string cls, string label)
    {
        // 4.2.0.53 exposes a textual reference as ChatTextItemView with the
        // complete reply followed by a reference-summary line. This exception
        // belongs only to a Reader-provided quote slot in the unique sequence;
        // ordinary text slots still require the entire label to match.
        if (key.Kind == "quote" && cls == "mmui::ChatTextItemView")
        {
            if (String.IsNullOrEmpty(key.Text) || String.IsNullOrEmpty(label))
                return false;
            string normalized = label.Replace("\r\n", "\n"), reply = key.Text.Replace("\r\n", "\n");
            return normalized.StartsWith(reply + "\n", StringComparison.Ordinal) &&
                   normalized.Length > reply.Length + 1 &&
                   !String.IsNullOrWhiteSpace(normalized.Substring(reply.Length + 1));
        }
        string kind = QtQuoteClassKind(cls);
        if ((kind == "card" || cls == "mmui::ChatBubbleReferItemView") && label != null)
        {
            foreach (string medium in new[] { "image", "video", "voice", "sticker" })
                foreach (string name in QtQuoteTypeLabels(medium))
                    if (label == "[" + name + "]" || label.StartsWith("[" + name + "]\n", StringComparison.Ordinal) ||
                        label == name || label.StartsWith(name + "\n", StringComparison.Ordinal))
                        kind = medium;
        }
        if (kind != (QtQuoteCardKind(key.Kind) ? "card" : key.Kind))
            return false;
        if (key.Text == null)
            return true;
        if (key.Kind == "text")
            return key.Text == label;
        if (String.IsNullOrEmpty(label))
            return false;
        string[] lines = label.Replace("\r\n", "\n").Split('\n');
        if (label == key.Text || lines[0] == key.Text)
            return true;
        foreach (var type in QtQuoteTypeLabels(key.Kind))
        {
            string prefix = "[" + type + "]";
            if ((lines[0] == prefix || lines[0] == type) && lines.Length > 1 && lines[1] == key.Text)
                return true;
            if (lines[0] == prefix + key.Text || lines[0] == prefix + " " + key.Text)
                return true;
        }
        return false;
    }
    static int QtQuoteSequenceIndex(QtQuotePattern pattern, int count, Func<int, QtQuoteRowKey, bool> matches)
    {
        int chosen = -1;
        for (int start = 0; start <= count - pattern.Rows.Length; start++)
        {
            bool same = true;
            for (int i = 0; i < pattern.Rows.Length; i++)
                if (!matches(start + i, pattern.Rows[i]))
                {
                    same = false;
                    break;
                }
            if (!same)
                continue;
            Need(chosen < 0, "QT_QUOTE_SOURCE_AMBIGUOUS");
            chosen = start + pattern.Index;
        }
        return chosen;
    }
    static string QtQuoteRuntime(AutomationElement element)
    {
        return String.Join(",", element.GetRuntimeId());
    }
    static bool QtQuoteWithin(AutomationElement element, AutomationElement ancestor)
    {
        string expected = QtQuoteRuntime(ancestor);
        for (int i = 0; element != null && i < 48; i++, element = TreeWalker.RawViewWalker.GetParent(element))
            if (QtQuoteRuntime(element) == expected)
                return true;
        return false;
    }
    static bool QtQuotePreviewText(string label, string text)
    {
        if (String.IsNullOrEmpty(label) || String.IsNullOrEmpty(text))
            return false;
        if (label == text)
            return true;
        // The preview can include a display name, a colon, and the quoted text.
        int colon = label.IndexOfAny(new[] { ':', '：' });
        return colon > 0 && colon <= 128 && label.Substring(0, colon).IndexOfAny(new[] { '\r', '\n' }) < 0 &&
               (label.Substring(colon + 1) == text || label.Substring(colon + 1) == " " + text);
    }
    static int QtQuoteSelfTest()
    {
        int checks = 0;
        Need(QtQuoteMenuRootShape("mmui::XMenu", ControlType.Window) &&
                 !QtQuoteMenuRootShape("mmui::XMenu", ControlType.Menu) &&
                 !QtQuoteMenuRootShape("QWidget", ControlType.Window),
             "QT_TEST_QUOTE_42053_MENU_WINDOW_PARENT");
        checks++;
        string body = "Time: 8:30";
        foreach (string label in new[] { body, "Alice: " + body, "张三：" + body })
        {
            Need(QtQuotePreviewText(label, body), "QT_TEST_QUOTE_PREVIEW_EXACT");
            checks++;
        }
        foreach (string label in new[] { null, "", "Alice: Time: 8…", "prefix " + body, "Alice: " + body + " extra",
                                         "A\nB:" + body })
        {
            Need(!QtQuotePreviewText(label, body), "QT_TEST_QUOTE_PREVIEW_MISMATCH");
            checks++;
        }
        var anchor = new QtQuoteRowKey { Kind = "text", Text = "test anchor" };
        var image = new QtQuoteRowKey { Kind = "image" };
        var pattern = new QtQuotePattern { Rows = new[] { anchor, image, image }, Index = 2 };
        string[] classes = { "mmui::ChatTextItemView", "mmui::ChatImageItemView", "mmui::ChatImageItemView" };
        string[] names = { "test anchor", "[图片]", "[图片]" };
        Need(QtQuoteSequenceIndex(pattern, 3, delegate(int i, QtQuoteRowKey key) {
                 return QtQuoteNamedRow(key, classes[i], names[i]);
             }) == 2, "QT_TEST_QUOTE_SECOND_IMAGE");
        checks++;
        Expect(delegate {
            QtQuoteSequenceIndex(pattern, 6, delegate(int i, QtQuoteRowKey key) {
                return QtQuoteNamedRow(key, classes[i % 3], names[i % 3]);
            });
        }, "QT_QUOTE_SOURCE_AMBIGUOUS");
        checks++;
        Need(!QtQuoteNamedRow(image, "mmui::ChatTextItemView", "[图片]"), "QT_TEST_QUOTE_LITERAL_IS_NOT_IMAGE");
        checks++;
        foreach (string kind in new[] { "record", "link", "file", "card" })
        {
            var key = new QtQuoteRowKey { Kind = kind, Text = "标题" };
            Need(QtQuoteNamedRow(key, "mmui::ChatBubbleItemView", QtQuoteTypeLabels(kind)[0] + "\n标题\n摘要") &&
                     !QtQuoteNamedRow(key, "mmui::ChatTextItemView", "标题") &&
                     !QtQuoteNamedRow(key, "mmui::ChatBubbleItemView", "另一标题\n标题"),
                 "QT_TEST_QUOTE_CARD_TITLE");
            checks++;
        }
        Need(QtQuoteNamedRow(new QtQuoteRowKey { Kind = "voice" }, "mmui::ChatVoiceItemView", "3″") &&
                 !QtQuoteNamedRow(new QtQuoteRowKey { Kind = "voice" }, "mmui::ChatImageItemView", "3″"),
             "QT_TEST_QUOTE_VOICE_TYPE");
        checks++;
        Need(QtQuoteNamedRow(new QtQuoteRowKey { Kind = "sticker" }, "mmui::ChatBubbleItemView", "[动画表情]") &&
                 QtQuoteNamedRow(new QtQuoteRowKey { Kind = "video" }, "mmui::ChatBubbleItemView", "视频\n00:06") &&
                 !QtQuoteNamedRow(image, "mmui::ChatBubbleItemView", "视频\n00:06"),
             "QT_TEST_QUOTE_MEDIA_CLASS");
        checks++;
        var quoted = new QtQuoteRowKey { Kind = "quote", Text = "complete reply" };
        Need(QtQuoteNamedRow(quoted, "mmui::ChatTextItemView", "complete reply\nreference summary") &&
                 QtQuoteNamedRow(quoted, "mmui::ChatTextItemView", "complete reply\r\nreference summary"),
             "QT_TEST_QUOTE_42053_TEXT_CARRIER_IN_EXPECTED_QUOTE_SLOT");
        checks++;
        foreach (string wrong in new[] { "complete reply", "complete reply\n",
                                         "complete reply extra\nreference summary",
                                         "prefix complete reply\nreference summary" })
        {
            Need(!QtQuoteNamedRow(quoted, "mmui::ChatTextItemView", wrong), "QT_TEST_QUOTE_REPLY_AND_SUMMARY_BOUNDARY");
            checks++;
        }
        Need(!QtQuoteNamedRow(new QtQuoteRowKey { Kind = "text", Text = "complete reply" }, "mmui::ChatTextItemView",
                              "complete reply\nreference summary") &&
                 QtQuoteNamedRow(new QtQuoteRowKey { Kind = "text", Text = "complete reply\nreference summary" },
                                 "mmui::ChatTextItemView", "complete reply\nreference summary"),
             "QT_TEST_QUOTE_ORDINARY_MULTILINE_TEXT_STAYS_EXACT");
        checks++;
        var sticker = new QtQuoteRowKey { Kind = "sticker" };
        Need(QtQuoteNamedRow(sticker, "mmui::ChatBubbleReferItemView", "[表情]") &&
                 !QtQuoteNamedRow(sticker, "mmui::ChatTextItemView", "[表情]") &&
                 !QtQuoteNamedRow(sticker, "mmui::ChatBubbleReferItemView", "[图片]") &&
                 !QtQuoteNamedRow(quoted, "mmui::ChatBubbleReferItemView", "[表情]"),
             "QT_TEST_QUOTE_42053_REFER_MEDIA_EXPLICIT_LABEL");
        checks++;
        var rich = new QtQuotePattern { Rows = new[] { anchor, quoted, sticker }, Index = 2 };
        string[] currentClasses = { "mmui::ChatTextItemView", "mmui::ChatTextItemView",
                                    "mmui::ChatBubbleReferItemView" };
        string[] currentLabels = { "test anchor", "complete reply\nreference summary", "[表情]" };
        Need(QtQuoteSequenceIndex(rich, 3, delegate(int i, QtQuoteRowKey key) {
                 return QtQuoteNamedRow(key, currentClasses[i], currentLabels[i]);
             }) == 2, "QT_TEST_QUOTE_42053_TEXT_QUOTE_STICKER_SEQUENCE");
        checks++;
        Expect(delegate {
            QtQuoteSequenceIndex(rich, 6, delegate(int i, QtQuoteRowKey key) {
                return QtQuoteNamedRow(key, currentClasses[i % 3],
                                       i == 4 ? "complete reply\ndifferent reference summary" : currentLabels[i % 3]);
            });
        }, "QT_QUOTE_SOURCE_AMBIGUOUS");
        checks++;
        Need(QtQuotePreviewLabel("张三：[图片]", "[图片]", pattern) &&
                 !QtQuotePreviewLabel("张三：[视频]", "[图片]", pattern),
             "QT_TEST_QUOTE_PREVIEW_MEDIA");
        checks++;
        foreach (string kind in new[] { "image", "sticker", "video" })
        {
            Need(QtQuoteThumbnailCarrier(kind, "mmui::XImageView", ControlType.Button) &&
                     QtQuoteThumbnailCarrier(kind, "fixture", ControlType.Image),
                 "QT_TEST_QUOTE_42053_THUMBNAIL_CARRIER");
            checks++;
        }
        Need(!QtQuoteThumbnailCarrier("text", "mmui::XImageView", ControlType.Button) &&
                 !QtQuoteThumbnailCarrier("voice", "mmui::XImageView", ControlType.Button) &&
                 !QtQuoteThumbnailCarrier("sticker", "mmui::XButton", ControlType.Button) &&
                 !QtQuoteThumbnailCarrier("sticker", "mmui::XImage", ControlType.Button),
             "QT_TEST_QUOTE_NOT_TOOLBAR_OR_CLOSE_ICON");
        checks++;
        Need(QtQuoteEmptyViewportShape("QWidget", ControlType.Group, "") &&
                 !QtQuoteEmptyViewportShape("QWidget", ControlType.Image, "") &&
                 !QtQuoteEmptyViewportShape("mmui::XImageView", ControlType.Group, "") &&
                 !QtQuoteEmptyViewportShape("QWidget", ControlType.Group, "attachment"),
             "QT_TEST_EMPTY_EDITOR_VIEWPORT_IS_NOT_RICH_CONTENT");
        checks++;
        return checks;
    }
    static QtUiaNode QtQuoteEditor(Binding binding)
    {
        return QtUiaResolveRoles(binding, new[] { "header", "editor" })["editor"].Node;
    }
    static object QtInspectQuoteRows(Dictionary<string, object> request)
    {
        var expected = QtUiaWarmExpected(Get(request, "expectedBinding"));
        var binding = QtUiaWarmBinding(expected);
        long revision = Interlocked.Read(ref Revision);
        uint tick = QtInputTick();
        IntPtr foreground = GetForegroundWindow();
        string text = Text(request, "quoteText");
        Need(text != null && text.Length > 0 && text.Length <= 4096, "QT_QUOTE_REQUEST_INVALID");
        var pattern = QtQuoteRequestPattern(request, text);
        Need(pattern != null, "QT_QUOTE_REQUEST_INVALID");
        var editor = QtQuoteEditor(binding);
        var page = QtUiaAncestor(editor, "mmui::ChatMessagePage");
        var list = QtQuoteList(page.Element, editor.Pid);
        string listId = QtQuoteRuntime(list);
        var children = list.FindAll(TreeScope.Descendants,
                                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem));
        Need(children.Count < 2048, "QT_QUOTE_SOURCE_AMBIGUOUS");
        var rows = new List<object>();
        foreach (AutomationElement row in children)
        {
            var info = row.Current;
            Need(info.ProcessId == binding.Pid, "QT_QUOTE_WINDOW_CHANGED");
            var parent = TreeWalker.RawViewWalker.GetParent(row);
            while (parent != null && parent.Current.ControlType != ControlType.ListItem &&
                   parent.Current.ControlType != ControlType.List)
                parent = TreeWalker.RawViewWalker.GetParent(parent);
            if (parent == null || QtQuoteRuntime(parent) != listId)
                continue;
            string label = info.Name ?? "";
            var matches = new List<object>();
            for (int index = 0; index < pattern.Rows.Length; index++)
            {
                var key = pattern.Rows[index];
                matches.Add(Data(
                    "index", index, "expectedKind", key.Kind, "matched", QtQuoteNamedRow(key, info.ClassName, label),
                    "exactText", key.Text != null && label == key.Text, "firstLineText",
                    key.Text != null && label.Replace("\r\n", "\n").Split('\n')[0] == key.Text, "lastLineText",
                    key.Text != null && label.EndsWith("\n" + key.Text, StringComparison.Ordinal), "containsText",
                    key.Text != null && label.IndexOf(key.Text, StringComparison.Ordinal) >= 0));
            }
            var structure = new List<object>();
            bool interesting = info.ClassName == "mmui::ChatBubbleReferItemView";
            foreach (var key in pattern.Rows)
                if (key.Kind == "quote" && key.Text != null && label.IndexOf(key.Text, StringComparison.Ordinal) >= 0)
                    interesting = true;
            if (interesting)
            {
                var walker = TreeWalker.RawViewWalker;
                Action<AutomationElement, int> walk = null;
                walk = delegate(AutomationElement node, int depth)
                {
                    if (depth > 8 || structure.Count >= 48)
                        return;
                    var c = node.Current;
                    Need(c.ProcessId == binding.Pid, "QT_QUOTE_WINDOW_CHANGED");
                    structure.Add(Data("depth", depth, "className", c.ClassName, "controlType",
                                       c.ControlType.ProgrammaticName, "offscreen", c.IsOffscreen));
                    for (var child = walker.GetFirstChild(node); child != null && structure.Count < 48;
                         child = walker.GetNextSibling(child))
                        walk(child, depth + 1);
                };
                walk(row, 0);
            }
            var bounds = info.BoundingRectangle;
            rows.Add(Data("className", info.ClassName, "controlType", info.ControlType.ProgrammaticName, "classKind",
                          QtQuoteClassKind(info.ClassName), "labelChars", label.Length, "lineCount",
                          label.Split('\n').Length, "timeDivider", QtQuoteTimeDivider(info.ClassName, label),
                          "offscreen", info.IsOffscreen, "enabled", info.IsEnabled, "bounds",
                          bounds.IsEmpty ? null
                                         : Data("left", bounds.Left, "top", bounds.Top, "right", bounds.Right, "bottom",
                                                bounds.Bottom),
                          "matches", matches, "structure", structure));
        }
        Need(revision == Interlocked.Read(ref Revision) && tick == QtInputTick() &&
                 GetForegroundWindow() == foreground && QtUiaLocatorBindingMatches(binding, QtUiaWarmBinding(expected)),
             "QT_QUOTE_WINDOW_CHANGED");
        int total = rows.Count;
        if (rows.Count > 20)
            rows.RemoveRange(0, rows.Count - 20);
        var input = QtUiaAncestor(editor, "mmui::ChatInputView").Element;
        var previews = new List<object>();
        var previewWalker = TreeWalker.RawViewWalker;
        Action<AutomationElement, string, int> previewWalk = null;
        previewWalk = delegate(AutomationElement node, string parentClass, int depth)
        {
            if (depth > 16 || previews.Count >= 128)
                return;
            var c = node.Current;
            Need(c.ProcessId == binding.Pid, "QT_QUOTE_WINDOW_CHANGED");
            string cls = c.ClassName ?? "";
            bool insideEditor = QtQuoteWithin(node, editor.Element);
            string label = insideEditor ? "" : c.Name ?? "";
            var area = c.BoundingRectangle;
            previews.Add(Data(
                "depth", depth, "className", cls, "parentClass", parentClass, "controlType",
                c.ControlType.ProgrammaticName, "offscreen", c.IsOffscreen, "insideEditor", insideEditor, "labelChars",
                label.Length, "hasColon", label.IndexOfAny(new[] { ':', '：' }) >= 0, "previewLabelMatches",
                !insideEditor && QtQuotePreviewLabel(label, text, pattern), "thumbnailMatches",
                !insideEditor && QtQuoteThumbnail(node, input, pattern), "bounds",
                area.IsEmpty ? null
                             : Data("left", area.Left, "top", area.Top, "right", area.Right, "bottom", area.Bottom)));
            if (insideEditor)
                return;
            for (var child = previewWalker.GetFirstChild(node); child != null && previews.Count < 128;
                 child = previewWalker.GetNextSibling(child))
                previewWalk(child, cls, depth + 1);
        };
        previewWalk(input, "", 0);
        Need(revision == Interlocked.Read(ref Revision) && tick == QtInputTick() &&
                 GetForegroundWindow() == foreground && QtUiaLocatorBindingMatches(binding, QtUiaWarmBinding(expected)),
             "QT_QUOTE_WINDOW_CHANGED");
        return Data("version", 1, "readOnly", true, "inputSent", false, "focusChanged", false, "clipboardAccessed",
                    false, "totalRows", total, "tailRows", rows, "previewStructure", previews, "locatorLength",
                    pattern.Rows.Length, "targetIndex", pattern.Index, "textIncluded", false);
    }
    static bool QtQuoteInputClear(QtUiaNode editor, bool strict = true)
    {
        var input = QtUiaAncestor(editor, "mmui::ChatInputView").Element;
        var controls = input.FindAll(
            TreeScope.Descendants,
            new OrCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text),
                            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Group)));
        if (controls.Count > 256)
            return false;
        foreach (AutomationElement item in controls)
        {
            var info = item.Current;
            if (info.IsOffscreen || QtQuoteWithin(item, editor.Element))
                continue;
            var cls = info.ClassName ?? "";
            if (cls.IndexOf("Quote", StringComparison.OrdinalIgnoreCase) >= 0 ||
                cls.IndexOf("Refer", StringComparison.OrdinalIgnoreCase) >= 0)
                return false;
            if (info.ControlType != ControlType.Text || String.IsNullOrWhiteSpace(info.Name))
                continue;
            var parent = TreeWalker.RawViewWalker.GetParent(item);
            bool toolbar = false;
            for (int depth = 0; parent != null && QtQuoteRuntime(parent) != QtQuoteRuntime(input) && depth < 40;
                 depth++, parent = TreeWalker.RawViewWalker.GetParent(parent))
            {
                var p = parent.Current;
                if (p.ControlType == ControlType.Button || p.ControlType == ControlType.ToolBar ||
                    (p.ClassName ?? "").Contains("Toolbar"))
                {
                    toolbar = true;
                    break;
                }
            }
            // Standard, unlabelled input hints are not proof of a quote. A
            // sender-prefixed label outside the edit and toolbar is.
            if (!toolbar && (strict || info.Name.IndexOfAny(new[] { ':', '：' }) > 0))
                return false;
        }
        return true;
    }
    static bool QtQuoteEmptyViewportShape(string className, ControlType type, string name)
    {
        return className == "QWidget" && type == ControlType.Group && String.IsNullOrEmpty(name);
    }
    static bool QtQuoteEditorContentClear(QtUiaNode editor)
    {
        var element = editor.Element;
        object value, text;
        if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out value) || ((ValuePattern)value).Current.Value != "")
            return false;
        var child = TreeWalker.ContentViewWalker.GetFirstChild(element);
        bool hasText = element.TryGetCurrentPattern(TextPattern.Pattern, out text);
        if (hasText)
        {
            var range = ((TextPattern)text).DocumentRange;
            if (range.GetText(1).Length != 0 || range.GetChildren().Length != 0)
                return false;
        }
        if (child == null)
            return true;
        // WeChat 4.2.0.53 exposes an empty Qt viewport under the blank editor.
        // This viewport can report keyboard focus while the editor is empty.
        // Require empty document text and rule out any other raw descendants.
        var properties = child.Current;
        var raw = TreeWalker.RawViewWalker;
        return hasText && QtQuoteEmptyViewportShape(properties.ClassName, properties.ControlType, properties.Name) &&
               properties.ProcessId == editor.Pid && !properties.BoundingRectangle.IsEmpty &&
               element.Current.BoundingRectangle.Contains(properties.BoundingRectangle) &&
               Object.Equals(raw.GetFirstChild(element), child) && raw.GetNextSibling(child) == null &&
               raw.GetFirstChild(child) == null && child.TryGetCurrentPattern(ValuePattern.Pattern, out value) &&
               ((ValuePattern)value).Current.Value == "";
    }
    static object QtCheckClearQuote(Dictionary<string, object> request)
    {
        var frame = QtGuard(request, true);
        bool captureTemplate = request.ContainsKey("emptyEditorRect");
        Rect template = new Rect();
        if (captureTemplate)
        {
            template = ParseRect(Get(request, "emptyEditorRect"));
            Need(!frame.MetadataOnly && frame.Anchors.Count == 1, "QT_EMPTY_EDITOR_TEMPLATE_SCOPE_INVALID");
            QtNeedDraftSource(frame, ParseRect(Get(request, "headerRect")), template);
        }
        var editor = QtQuoteEditor(frame.Binding);
        if (captureTemplate)
        {
            // OCR may include the blank padding surrounding the UIA edit control.
            Need(Contains(editor.Rect, template) || Contains(template, editor.Rect),
                 "QT_EMPTY_EDITOR_TEMPLATE_SCOPE_INVALID");
        }
        bool clear = QtQuoteInputClear(editor) && QtQuoteEditorContentClear(editor);
        QtQuoteGuardWindow(frame, false);
        if (!clear)
            return Data("clear", false);
        var result = Data("clear", true);
        if (captureTemplate)
        {
            string current = QtHash(QtPixels(frame.Binding, template));
            QtGuard(request, true);
            result["emptyEditorSha256"] = current;
        }
        QtActiveQuote = null;
        return result;
    }
    static bool QtQuotePreviewLabel(string label, string text, QtQuotePattern pattern)
    {
        if (QtQuotePreviewText(label, text))
            return true;
        if (pattern == null)
            return false;
        if (pattern.Target.Kind == "voice" && label != null)
        {
            string body = label;
            int colon = body.IndexOfAny(new[] { ':', '：' });
            if (colon > 0 && colon <= 128)
                body = body.Substring(colon + 1).TrimStart(' ');
            if (System.Text.RegularExpressions.Regex.IsMatch(body,
                                                             @"^\[(?:语音|語音|Voice)\] ?[1-9]\d?\s*(?:秒|[""″”]|s)$"))
                return true;
        }
        foreach (var type in QtQuoteTypeLabels(pattern.Target.Kind))
        {
            if (QtQuotePreviewText(label, "[" + type + "]"))
                return true;
            if (pattern.Target.Text != null && (QtQuotePreviewText(label, "[" + type + "]" + text) ||
                                                QtQuotePreviewText(label, "[" + type + "] " + text)))
                return true;
        }
        return false;
    }
    static bool QtQuoteThumbnailCarrier(string kind, string cls, ControlType type)
    {
        return (kind == "image" || kind == "sticker" || kind == "video") &&
               (type == ControlType.Image || type == ControlType.Button && cls == "mmui::XImageView");
    }
    static bool QtQuoteThumbnail(AutomationElement item, AutomationElement input, QtQuotePattern pattern)
    {
        if (pattern == null ||
            !QtQuoteThumbnailCarrier(pattern.Target.Kind, item.Current.ClassName, item.Current.ControlType))
            return false;
        bool button = item.Current.ControlType == ControlType.Button, reference = false;
        for (var parent = TreeWalker.RawViewWalker.GetParent(item);
             parent != null && QtQuoteRuntime(parent) != QtQuoteRuntime(input);
             parent = TreeWalker.RawViewWalker.GetParent(parent))
        {
            if (parent.Current.ControlType == ControlType.Button || parent.Current.ControlType == ControlType.ToolBar)
                return false;
            var cls = parent.Current.ClassName ?? "";
            if (button)
            {
                if (cls == "mmui::ReferView" && parent.Current.ControlType == ControlType.Custom)
                    reference = true;
                if (cls == "mmui::ComposeReferView" && parent.Current.ControlType == ControlType.Group)
                    return reference;
            }
            else if (cls.IndexOf("Refer", StringComparison.OrdinalIgnoreCase) >= 0 ||
                     cls.IndexOf("Quote", StringComparison.OrdinalIgnoreCase) >= 0)
                return true;
        }
        return false;
    }
    static AutomationElement QtQuotePreview(QtUiaNode editor, string text, QtQuotePattern pattern = null)
    {
        var input = QtUiaAncestor(editor, "mmui::ChatInputView").Element;
        var controls = input.FindAll(
            TreeScope.Descendants,
            new OrCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Group),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Image),
                new AndCondition(new PropertyCondition(AutomationElement.ClassNameProperty, "mmui::XImageView"),
                                 new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button))));
        Need(controls.Count <= 256, "QT_QUOTE_PREVIEW_AMBIGUOUS");
        AutomationElement match = null;
        foreach (AutomationElement item in controls)
        {
            var info = item.Current;
            if (info.ProcessId != editor.Pid || info.IsOffscreen || QtQuoteWithin(item, editor.Element) ||
                !(QtQuotePreviewLabel(info.Name, text, pattern) || QtQuoteThumbnail(item, input, pattern)))
                continue;
            if (match != null)
            {
                if (QtQuoteWithin(match, item))
                    continue;
                Need(QtQuoteWithin(item, match), "QT_QUOTE_PREVIEW_AMBIGUOUS");
            }
            match = item;
        }
        return match;
    }
    static AutomationElement QtQuoteRow(QtUiaNode editor, string text, bool includeOffscreen = false,
                                        QtQuotePattern pattern = null)
    {
        var page = QtUiaAncestor(editor, "mmui::ChatMessagePage").Element;
        if (pattern != null)
        {
            var list = QtQuoteList(page, editor.Pid);
            var children =
                list.FindAll(TreeScope.Descendants,
                             new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem));
            Need(children.Count < 2048, "QT_QUOTE_SOURCE_AMBIGUOUS");
            var ordered = new List<AutomationElement>();
            var classes = new List<string>();
            var labels = new List<string>();
            string listId = QtQuoteRuntime(list);
            foreach (AutomationElement row in children)
            {
                var item = row.Current;
                Need(item.ProcessId == editor.Pid, "QT_QUOTE_WINDOW_CHANGED");
                var parent = TreeWalker.RawViewWalker.GetParent(row);
                while (parent != null && parent.Current.ControlType != ControlType.ListItem &&
                       parent.Current.ControlType != ControlType.List)
                    parent = TreeWalker.RawViewWalker.GetParent(parent);
                if (parent == null || QtQuoteRuntime(parent) != listId)
                    continue;
                if (QtQuoteTimeDivider(item.ClassName, item.Name))
                    continue;
                ordered.Add(row);
                classes.Add(item.ClassName);
                labels.Add(item.Name);
            }
            int hit = QtQuoteSequenceIndex(pattern, ordered.Count, delegate(int i, QtQuoteRowKey key) {
                return QtQuoteNamedRow(key, classes[i], labels[i]);
            });
            if (hit < 0)
                return null;
            var target = ordered[hit];
            return target.Current.IsEnabled && (includeOffscreen || !target.Current.IsOffscreen) ? target : null;
        }
        var rows = page.FindAll(
            TreeScope.Descendants,
            new AndCondition(new PropertyCondition(AutomationElement.ClassNameProperty, "mmui::ChatTextItemView"),
                             new PropertyCondition(AutomationElement.NameProperty, text)));
        AutomationElement match = null;
        foreach (AutomationElement row in rows)
        {
            var info = row.Current;
            if ((!includeOffscreen && info.IsOffscreen) || !info.IsEnabled || info.ProcessId != editor.Pid)
                continue;
            AutomationElement list = TreeWalker.RawViewWalker.GetParent(row);
            while (list != null && list.Current.ControlType != ControlType.List &&
                   QtQuoteRuntime(list) != QtQuoteRuntime(page))
                list = TreeWalker.RawViewWalker.GetParent(list);
            if (list == null || list.Current.ControlType != ControlType.List)
                continue;
            Need(match == null, "QT_QUOTE_SOURCE_AMBIGUOUS");
            match = row;
        }
        return match;
    }
    static AutomationElement QtQuoteList(AutomationElement page, int pid)
    {
        var lists = page.FindAll(
            TreeScope.Descendants,
            new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.List),
                             new OrCondition(new PropertyCondition(AutomationElement.NameProperty, "消息"),
                                             new PropertyCondition(AutomationElement.NameProperty, "訊息"),
                                             new PropertyCondition(AutomationElement.NameProperty, "Messages"))));
        Need(lists.Count == 1 && lists[0].Current.ProcessId == pid && !lists[0].Current.IsOffscreen,
             "QT_QUOTE_SOURCE_NOT_VISIBLE");
        return lists[0];
    }
    static AutomationElement QtFindQuoteHistory(QtUiaNode editor, string text, QtFrame frame, QtQuotePattern pattern,
                                                bool allowScroll)
    {
        var match = QtQuoteRow(editor, text, false, pattern);
        if (match != null)
            return match;
        var page = QtUiaAncestor(editor, "mmui::ChatMessagePage").Element;
        object capability;
        var list = QtQuoteList(page, editor.Pid);
        ScrollPattern scroll =
            list.TryGetCurrentPattern(ScrollPattern.Pattern, out capability) ? (ScrollPattern)capability : null;
        double original =
            scroll != null && scroll.Current.VerticallyScrollable ? scroll.Current.VerticalScrollPercent : -1;
        bool moved = false, found = false;
        try
        {
            var offscreen = QtQuoteRow(editor, text, true, pattern);
            if (offscreen == null && list.TryGetCurrentPattern(ItemContainerPattern.Pattern, out capability))
            {
                var container = (ItemContainerPattern)capability;
                string anchor = text;
                if (pattern != null)
                    foreach (var row in pattern.Rows)
                    {
                        if (row.Kind == "text")
                        {
                            anchor = row.Text;
                            break;
                        }
                    }
                try
                {
                    offscreen = container.FindItemByProperty(null, AutomationElement.NameProperty, anchor);
                }
                catch (ArgumentException)
                {
                } // A provider can implement the pattern without supporting Name lookup.
                catch (InvalidOperationException)
                {
                }
                if (offscreen != null && offscreen.TryGetCurrentPattern(VirtualizedItemPattern.Pattern, out capability))
                {
                    QtQuoteGuardWindow(frame, false);
                    moved = true;
                    ((VirtualizedItemPattern)capability).Realize();
                }
            }
            if (offscreen != null && offscreen.TryGetCurrentPattern(ScrollItemPattern.Pattern, out capability))
            {
                QtQuoteGuardWindow(frame, false);
                moved = true;
                ((ScrollItemPattern)capability).ScrollIntoView();
            }
            if (moved)
            {
                for (int poll = 0; poll < 5; poll++)
                {
                    QtQuoteGuardWindow(frame, false);
                    match = QtQuoteRow(editor, text, false, pattern);
                    if (match != null)
                    {
                        found = true;
                        return match;
                    }
                    Thread.Sleep(10);
                }
            }
            Need(allowScroll && original >= 0, "QT_QUOTE_SOURCE_NOT_VISIBLE");
            // WeChat virtualizes older rows. Only scroll the verified message
            // list, stop at the top or when the provider stops advancing.
            long deadline = Now() + 2200;
            for (int i = 0; i < 12 && Now() < deadline; i++)
            {
                QtQuoteGuardWindow(frame, false);
                match = QtQuoteRow(editor, text, false, pattern);
                if (match != null)
                {
                    found = true;
                    return match;
                }
                double before = scroll.Current.VerticalScrollPercent;
                if (before <= 0)
                    break;
                QtQuoteGuardWindow(frame, false);
                moved = true;
                scroll.Scroll(ScrollAmount.NoAmount, ScrollAmount.LargeDecrement);
                for (int poll = 0; poll < 5 && Now() < deadline; poll++)
                {
                    QtQuoteGuardWindow(frame, false);
                    if (scroll.Current.VerticalScrollPercent != before)
                        break;
                    Thread.Sleep(10);
                }
                if (scroll.Current.VerticalScrollPercent == before)
                    break;
            }
            QtQuoteGuardWindow(frame, false);
            match = QtQuoteRow(editor, text, false, pattern);
            Need(match != null, "QT_QUOTE_SOURCE_NOT_VISIBLE");
            found = true;
            return match;
        }
        finally
        {
            if (original >= 0 && moved && !found)
            {
                QtQuoteGuardWindow(frame, false);
                scroll.SetScrollPercent(ScrollPattern.NoScroll, original);
                QtQuoteGuardWindow(frame, false);
            }
        }
    }
    static Point QtQuotePoint(AutomationElement row, Binding binding, bool self)
    {
        var bounds = row.Current.BoundingRectangle;
        Need(!bounds.IsEmpty && bounds.Width > 1 && bounds.Height > 1, "QT_QUOTE_SOURCE_NOT_VISIBLE");
        // A list item may span the entire chat pane. Prefer the text provider's
        // actual glyph bounds; for a full-row provider hit-test the bubble side.
        object pattern;
        if (row.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
        {
            var glyphs = ((TextPattern)pattern).DocumentRange.GetBoundingRectangles();
            if (glyphs.Length > 0 && glyphs[0].Width >= 2 && bounds.Contains(glyphs[0]))
                bounds = glyphs[0];
        }
        double offset = Math.Min(bounds.Width / 2, 82 * binding.Dpi / 96.0);
        var point = new System.Windows.Point(self ? bounds.Right - offset : bounds.Left + offset,
                                             bounds.Top + bounds.Height * .60);
        var hit = AutomationElement.FromPoint(point);
        var target = new Point((int)point.X, (int)point.Y);
        Need(hit != null && QtQuoteWithin(hit, row) && Owned(WindowFromPoint(target), binding.Window, binding.Pid),
             "QT_QUOTE_SOURCE_OBSCURED");
        return target;
    }
    static AutomationElement QtQuoteMenuItem(Binding binding)
    {
        var roots = new List<IntPtr>();
        FocusEnumWindows(delegate(IntPtr w, IntPtr unused) {
            uint pid;
            uint thread = GetWindowThreadProcessId(w, out pid);
            var name = new System.Text.StringBuilder(257);
            if (w != binding.Window && IsWindowVisible(w) && GetWindow(w, 4) == binding.Window && pid == binding.Pid &&
                thread == binding.Thread && GetClassName(w, name, name.Capacity) > 0 &&
                name.ToString() == "Qt51514QWindowToolSaveBits")
                roots.Add(w);
            return roots.Count <= 32;
        }, IntPtr.Zero);
        Need(roots.Count <= 32, "QT_QUOTE_MENU_AMBIGUOUS");
        AutomationElement found = null;
        foreach (var hwnd in roots)
        {
            var root = AutomationElement.FromHandle(hwnd);
            if (root == null || !QtQuoteMenuRootShape(root.Current.ClassName, root.Current.ControlType) ||
                root.Current.ProcessId != binding.Pid)
                continue;
            var items = root.FindAll(
                TreeScope.Descendants,
                new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuItem),
                                 new OrCondition(new PropertyCondition(AutomationElement.NameProperty, "引用"),
                                                 new PropertyCondition(AutomationElement.NameProperty, "Quote"))));
            foreach (AutomationElement item in items)
            {
                var info = item.Current;
                if (info.IsOffscreen || !info.IsEnabled || info.ProcessId != binding.Pid ||
                    info.ClassName != "mmui::XMenuView")
                    continue;
                var menu = TreeWalker.RawViewWalker.GetParent(item);
                if (menu == null || !QtQuoteMenuRootShape(menu.Current.ClassName, menu.Current.ControlType) ||
                    QtQuoteRuntime(menu) != QtQuoteRuntime(root))
                    continue;
                Need(found == null || QtQuoteRuntime(found) == QtQuoteRuntime(item), "QT_QUOTE_MENU_AMBIGUOUS");
                found = item;
            }
        }
        return found;
    }
    static void QtClickQuoteMenu(QtFrame frame, AutomationElement item)
    {
        var trace = Data("version", 1, "stage", "guard", "inputAttempted", false, "messageSendAttempted", false);
        try
        {
            QtQuoteGuardWindow(frame, true);
            var binding = frame.Binding;
            trace["stage"] = "item-relookup";
            var fresh = QtQuoteMenuItem(binding);
            trace["itemFound"] = fresh != null;
            trace["sameItemRuntime"] = fresh != null && QtQuoteRuntime(fresh) == QtQuoteRuntime(item);
            Need(Object.Equals(trace["sameItemRuntime"], true), "QT_QUOTE_MENU_UNCONFIRMED");
            var bounds = fresh.Current.BoundingRectangle;
            trace["stage"] = "item-bounds";
            trace["itemBounds"] = bounds.IsEmpty ? null
                                                 : Data("left", bounds.Left, "top", bounds.Top, "right", bounds.Right,
                                                        "bottom", bounds.Bottom);
            Need(!bounds.IsEmpty && bounds.Width > 4 && bounds.Height > 4, "QT_QUOTE_MENU_UNCONFIRMED");
            var point = new Point((int)Math.Round(bounds.Left + bounds.Width / 2),
                                  (int)Math.Round(bounds.Top + bounds.Height / 2));
            trace["point"] = Data("x", point.X, "y", point.Y);
            trace["stage"] = "window-binding";
            IntPtr direct = WindowFromPoint(point), window = GetAncestor(direct, 2);
            uint pid;
            uint thread = GetWindowThreadProcessId(window, out pid);
            var name = new System.Text.StringBuilder(257);
            Rect client = new Rect(), windowRect = new Rect();
            Point origin = new Point(0, 0);
            bool named = GetClassName(window, name, name.Capacity) > 0,
                 geometry = GetClientRect(window, out client) && ClientToScreen(window, ref origin),
                 windowBounds = GetWindowRect(window, out windowRect);
            IntPtr owner = GetWindow(window, 4);
            trace["window"] =
                Data("hwnd", window.ToInt64().ToString(), "hitHwnd", direct.ToInt64().ToString(), "pid", pid,
                     "threadId", thread, "expectedPid", binding.Pid, "expectedThreadId", binding.Thread, "owner",
                     owner.ToInt64().ToString(), "ownerMatches", owner == binding.Window, "isMain",
                     window == binding.Window, "visible", IsWindowVisible(window), "className", name.ToString(),
                     "geometryAvailable", geometry, "client", client.Report(), "origin",
                     Data("x", origin.X, "y", origin.Y), "bounds", windowBounds ? (object)windowRect.Report() : null);
            Need(window != binding.Window && IsWindowVisible(window) && owner == binding.Window && pid == binding.Pid &&
                     thread == binding.Thread && named && name.ToString() == "Qt51514QWindowToolSaveBits" && geometry,
                 "QT_QUOTE_MENU_UNCONFIRMED");
            trace["stage"] = "client-range";
            bool within = bounds.Left >= origin.X && bounds.Top >= origin.Y &&
                          bounds.Right <= origin.X + client.Width && bounds.Bottom <= origin.Y + client.Height,
                 owned = Owned(WindowFromPoint(point), window, binding.Pid);
            trace["rectWithinClient"] = within;
            trace["pointOwned"] = owned;
            Need(within && owned, "QT_QUOTE_MENU_UNCONFIRMED");
            trace["stage"] = "uia-hit";
            var hit = AutomationElement.FromPoint(new System.Windows.Point(point.X, point.Y));
            bool withinItem = hit != null && QtQuoteWithin(hit, fresh);
            var boundMenu = TreeWalker.RawViewWalker.GetParent(fresh);
            bool sameMenuRoot = hit != null && boundMenu != null && hit.Current.ProcessId == binding.Pid &&
                                QtQuoteMenuRootShape(hit.Current.ClassName, hit.Current.ControlType) &&
                                QtQuoteRuntime(hit) == QtQuoteRuntime(boundMenu);
            trace["sameMenuRoot"] = sameMenuRoot;
            trace["hit"] =
                Data("available", hit != null, "className", hit == null ? null : hit.Current.ClassName, "controlType",
                     hit == null ? null : hit.Current.ControlType.ProgrammaticName, "withinItem", withinItem,
                     "sameRuntime", hit != null && QtQuoteRuntime(hit) == QtQuoteRuntime(fresh));
            // 4.2.0.53's hit-test returns XMenu itself for its virtual items.
            // The exact fresh item rectangle and Win32 popup are already bound;
            // accept only that same root, never a different overlapping menu.
            Need(withinItem || sameMenuRoot, "QT_QUOTE_MENU_UNCONFIRMED");
            QtQuoteGuardWindow(frame, true);
            trace["stage"] = "click";
            var events = ClickEvents(point.X, point.Y, QtDesktopRect());
            InputAttempted = true;
            trace["inputAttempted"] = true;
            ObserveMouseIntent(0x201, point);
            uint accepted = SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(Input)));
            trace["acceptedEvents"] = accepted;
            if (accepted != events.Length)
            {
                var release = ClickReleases(accepted);
                if (release.Length > 0)
                    SendInput((uint)release.Length, release, Marshal.SizeOf(typeof(Input)));
                throw new Fault("QT_QUOTE_MENU_UNCONFIRMED");
            }
            QtRememberPointer(point, frame.Revision);
        }
        catch (Exception error)
        {
            error.Data["QtQuoteMenuSelection"] = trace;
            throw;
        }
    }
    static HashSet<IntPtr> QtQuoteVisibleWindows(Binding binding)
    {
        var result = new HashSet<IntPtr>();
        FocusEnumWindows(delegate(IntPtr w, IntPtr unused) {
            uint pid;
            GetWindowThreadProcessId(w, out pid);
            if (pid == binding.Pid && IsWindowVisible(w))
                result.Add(w);
            return result.Count < 64;
        }, IntPtr.Zero);
        return result;
    }
    static object QtQuoteMenuDiagnostics(QtFrame frame, HashSet<IntPtr> before, Point point,
                                         AutomationElement sourceRow)
    {
        var binding = frame.Binding;
        Need(!Stopping && Interlocked.Read(ref Revision) == frame.Revision &&
                 WindowIdentity.Same(QtFocusWindow(binding.Window, QtExecutable), binding.Identity),
             "QT_QUOTE_WINDOW_CHANGED");
        var windows = new List<object>();
        long deadline = Now() + 350;
        foreach (IntPtr window in QtQuoteVisibleWindows(binding))
        {
            bool fresh = !before.Contains(window);
            if (window == binding.Window || !fresh)
                continue;
            uint pid;
            uint thread = GetWindowThreadProcessId(window, out pid);
            var cls = new System.Text.StringBuilder(257);
            GetClassName(window, cls, cls.Capacity);
            Rect bounds;
            if (!GetWindowRect(window, out bounds))
                continue;
            var nodes = new List<object>();
            string failure = null;
            object image = null;
            try
            {
                var root = AutomationElement.FromHandle(window);
                var walker = TreeWalker.RawViewWalker;
                int visited = 0;
                Action<AutomationElement, string, int> walk = null;
                walk = delegate(AutomationElement item, string parentClass, int depth)
                {
                    if (item == null || ++visited > 96 || depth > 12 || Now() > deadline)
                        return;
                    var info = item.Current;
                    Need(info.ProcessId == binding.Pid, "QT_QUOTE_WINDOW_CHANGED");
                    string name = info.ClassName ?? "";
                    object capability;
                    // Menu labels are inspected only on a declared menu item
                    // or menu-class branch. Chat/list row text is never read.
                    bool label = info.ControlType == ControlType.MenuItem ||
                                 name.IndexOf("Menu", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                 parentClass.IndexOf("Menu", StringComparison.OrdinalIgnoreCase) >= 0;
                    bool? exact = label ? (bool?)(info.Name == "引用" || info.Name == "Quote") : null;
                    nodes.Add(Data("depth", depth, "className", name, "controlType", info.ControlType.ProgrammaticName,
                                   "parentClass", parentClass, "offscreen", info.IsOffscreen, "enabled", info.IsEnabled,
                                   "exactQuote", exact, "invoke",
                                   item.TryGetCurrentPattern(InvokePattern.Pattern, out capability)));
                    if (name.IndexOf("Chat", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("Recycler", StringComparison.OrdinalIgnoreCase) >= 0)
                        return;
                    for (var child = walker.GetFirstChild(item); child != null && visited < 96 && Now() < deadline;
                         child = walker.GetNextSibling(child))
                        walk(child, name, depth + 1);
                };
                walk(root, "", 0);
                Rect client;
                Point origin = new Point(0, 0);
                if (GetClientRect(window, out client) && ClientToScreen(window, ref origin) && client.Width > 0 &&
                    client.Height > 0 && client.Width <= 900 && client.Height <= 1800)
                {
                    Rect screen = new Rect(origin.X, origin.Y, origin.X + client.Width, origin.Y + client.Height);
                    if (FocusAreaOwned(screen, window, binding.Pid))
                        using (var bitmap = new System.Drawing.Bitmap(client.Width, client.Height))
                        {
                            using (var graphic = System.Drawing.Graphics.FromImage(bitmap)) graphic.CopyFromScreen(
                                origin.X, origin.Y, 0, 0, new System.Drawing.Size(client.Width, client.Height));
                            string file =
                                System.IO.Path.Combine(QtFrames, "qt-" + Guid.NewGuid().ToString("N") + ".png");
                            bitmap.Save(file, System.Drawing.Imaging.ImageFormat.Png);
                            image = Data("file", file, "width", client.Width, "height", client.Height);
                        }
                }
            }
            catch (Exception error)
            {
                failure = error is Fault ? error.Message : "QT_QUOTE_DIAGNOSTIC_UNAVAILABLE";
            }
            windows.Add(Data("hwnd", window.ToInt64().ToString(), "className", cls.ToString(), "sameThread",
                             thread == binding.Thread, "ownedByRoot", QtOwnedPopup(window, binding.Window), "owner",
                             GetWindow(window, 4).ToInt64().ToString(), "bounds", bounds.Report(), "nodes", nodes,
                             "failure", failure, "image", image));
        }
        var rowInfo = sourceRow.Current;
        object textPattern;
        return Data("version", 1, "inputSent", true, "messageSendAttempted", false, "quoteSelectionAttempted", false,
                    "rightClickPoint", Data("x", point.X, "y", point.Y), "sourceClass", rowInfo.ClassName, "sourceType",
                    rowInfo.ControlType.ProgrammaticName, "sourceTextPattern",
                    sourceRow.TryGetCurrentPattern(TextPattern.Pattern, out textPattern), "windows", windows);
    }
    static void QtQuoteGuardWindow(QtFrame frame, bool menuAllowed)
    {
        var binding = frame.Binding;
        var current = QtFocusWindow(binding.Window, QtExecutable);
        Need(!Stopping && Interlocked.Read(ref Revision) == frame.Revision && current.Pid == binding.Pid &&
                 current.Created == binding.Created,
             "QT_QUOTE_WINDOW_CHANGED");
        IntPtr foreground = GetForegroundWindow();
        Need(foreground == binding.Window || menuAllowed && QtOwnedPopup(foreground, binding.Window),
             "QT_QUOTE_WINDOW_CHANGED");
        NoKeysHeld();
    }
    static object QtPrepareQuoteHistory(Dictionary<string, object> request)
    {
        var frame = QtGuard(request, true);
        var step = QtParseTextStep(Get(request, "stepBinding"));
        Need(step != null && QtFocus.Active != null && QtFocus.Parked == null && QtSurface == "main" &&
                 QtPopup == null && QtPendingPopup == null,
             "QT_QUOTE_REQUEST_INVALID");
        QtStable(frame);
        QtQuoteGuardWindow(frame, false);
        return Data("ready", true, "readOnly", true, "inputSent", false, "binding", frame.Binding.Report());
    }
    static object QtAttachQuote(Dictionary<string, object> request)
    {
        var frame = QtGuard(request, true);
        var step = QtParseTextStep(Get(request, "stepBinding"));
        string text = Text(request, "quoteText");
        Need(step != null && QtFocus.Active != null && QtFocus.Parked == null && QtSurface == "main" &&
                 QtPopup == null && QtPendingPopup == null && text != null && text.Length > 0 && text.Length <= 4096 &&
                 text.IndexOf('\0') < 0 && Get(request, "fromSelf") is bool,
             "QT_QUOTE_REQUEST_INVALID");
        var pattern = QtQuoteRequestPattern(request, text);
        var binding = frame.Binding;
        var editor = QtQuoteEditor(binding);
        var page = QtUiaAncestor(editor, "mmui::ChatMessagePage");
        Need(QtQuoteEditorContentClear(editor), "QT_QUOTE_DRAFT_PRESENT");
        Need(QtQuoteInputClear(editor) && QtQuotePreview(editor, text, pattern) == null &&
                 QtQuoteMenuItem(binding) == null,
             "QT_QUOTE_DRAFT_PRESENT");
        var row =
            QtFindQuoteHistory(editor, text, frame, pattern, !Object.Equals(Get(request, "allowHistoryScroll"), false));
        var point = QtQuotePoint(row, binding, (bool)Get(request, "fromSelf"));
        bool diagnosticOnly = Object.Equals(Get(request, "diagnosticOnly"), true);
        var priorWindows = QtQuoteVisibleWindows(binding);
        QtStable(frame);
        QtQuoteGuardWindow(frame, false);
        var fresh = QtQuoteRow(editor, text, false, pattern);
        Need(fresh != null && QtQuoteRuntime(row) == QtQuoteRuntime(fresh) &&
                 point.Equals(QtQuotePoint(row, binding, (bool)Get(request, "fromSelf"))),
             "QT_QUOTE_SOURCE_CHANGED");
        var events = ClickEvents(point.X, point.Y, QtDesktopRect());
        events[1] = Mouse(0, 0, 8);
        events[2] = Mouse(0, 0, 16);
        QtQuoteGuardWindow(frame, false);
        InputAttempted = true;
        QtCurrent = null;
        uint accepted = SendInput(3, events, Marshal.SizeOf(typeof(Input)));
        if (accepted == 2)
            SendInput(1, new[] { Mouse(0, 0, 16) }, Marshal.SizeOf(typeof(Input)));
        Need(accepted == 3, "QT_QUOTE_MENU_UNCONFIRMED");
        QtRememberPointer(point, frame.Revision);
        if (diagnosticOnly)
        {
            long observeUntil = Now() + 250;
            while (Now() < observeUntil)
            {
                Need(!Stopping && Interlocked.Read(ref Revision) == frame.Revision, "QT_QUOTE_WINDOW_CHANGED");
                if (QtQuoteVisibleWindows(binding).Count > priorWindows.Count)
                    break;
                Thread.Sleep(10);
            }
            return Data("diagnosticOnly", true, "attached", false, "quoteMenuDiagnostics",
                        QtQuoteMenuDiagnostics(frame, priorWindows, point, row));
        }
        long deadline = Now() + 1200;
        AutomationElement menu = null;
        for (;;)
        {
            QtQuoteGuardWindow(frame, true);
            menu = QtQuoteMenuItem(binding);
            if (menu != null)
                break;
            Need(Now() < deadline, "QT_QUOTE_MENU_UNAVAILABLE");
            Thread.Sleep(15);
        }
        QtClickQuoteMenu(frame, menu);
        deadline = Now() + 1200;
        AutomationElement preview = null;
        for (;;)
        {
            QtQuoteGuardWindow(frame, true);
            if (GetForegroundWindow() == binding.Window)
            {
                preview = QtQuotePreview(editor, text, pattern);
                if (preview != null)
                    break;
            }
            Need(Now() < deadline, "QT_QUOTE_PREVIEW_UNVERIFIED");
            Thread.Sleep(15);
        }
        editor = QtQuoteEditor(binding);
        QtQuoteGuardWindow(frame, false);
        Need(QtUiaAncestor(editor, "mmui::ChatMessagePage").Runtime == page.Runtime, "QT_QUOTE_WINDOW_CHANGED");
        QtActiveQuote = new QtQuoteSelection { Token = Guid.NewGuid().ToString("N"),
                                               Step = step,
                                               Text = text,
                                               Pattern = pattern,
                                               Page = page.Runtime,
                                               Preview = QtQuoteRuntime(preview),
                                               Revision = frame.Revision,
                                               Binding = binding };
        return Data("attached", true, "quoteToken", QtActiveQuote.Token, "editorRect", editor.Rect.Report());
    }
    static void QtVerifyQuote(Dictionary<string, object> request, QtFrame frame)
    {
        if (QtVerifyOcrQuote(request, frame))
            return;
        var token = Text(request, "quoteToken");
        var quote = QtActiveQuote;
        if (token == null && quote == null)
        {
            string action = Text(request, "action");
            bool firstInput =
                (action == "paste" || action == "typeText") && Text(request, "expectedText") == Text(request, "text");
            if (frame != null && frame.MetadataOnly && (action == "submitTextEnter" || firstInput))
                Need(QtQuoteInputClear(QtQuoteEditor(frame.Binding), false), "QT_QUOTE_DRAFT_PRESENT");
            return;
        }
        Need(quote != null && token == quote.Token &&
                 QtSameTextStep(quote.Step, QtParseTextStep(Get(request, "stepBinding"))) && frame != null &&
                 frame.Revision == quote.Revision && QtUiaLocatorBindingMatches(frame.Binding, quote.Binding),
             "QT_QUOTE_CHANGED");
        QtQuoteGuardWindow(frame, false);
        var editor = QtQuoteEditor(frame.Binding);
        var preview = QtQuotePreview(editor, quote.Text, quote.Pattern);
        Need(QtUiaAncestor(editor, "mmui::ChatMessagePage").Runtime == quote.Page && preview != null &&
                 QtQuoteRuntime(preview) == quote.Preview,
             "QT_QUOTE_PREVIEW_UNVERIFIED");
        QtQuoteGuardWindow(frame, false);
    }
}
