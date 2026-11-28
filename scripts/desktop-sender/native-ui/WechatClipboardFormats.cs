internal static class ClipboardFormats
{
    internal static bool IsTextFormat(uint id)
    {
        return id == 1 || id == 7 || id == 13 || id == 16;
    }

    internal static bool IsProjectionCompanion(string name)
    {
        return name == "DataObject" || name == "WeChat_RichEdit_Format" || name == "QQ_Unicode_RichEdit_Format" ||
               name == "x-application-mimetype-xwechat" || name == "Ole Private Data";
    }

    internal static bool IsImageFormat(uint format, string name)
    {
        return format == 8 || format == 17 || format >= 0xc000 && (name == "PNG" || name == "image/png");
    }

    internal static bool IsClipboardPolicyFormat(uint format, string name)
    {
        return format >= 0xc000 && (name == "CanIncludeInClipboardHistory" || name == "CanUploadToCloudClipboard");
    }

    internal static bool IsOleCompanion(uint format, string name)
    {
        return format >= 0xc000 && (name == "DataObject" || name == "Ole Private Data");
    }

    // Chromium's CustomPlatformType/ClipboardFormatType use TYMED_HGLOBAL;
    // SourceRFHToken is serialized Pickle bytes and InternalSourceUrl is bytes.
    // Preserve both as opaque data; never parse, follow or print the source URL.
    internal static bool CanBackUp(uint format, string name)
    {
        return IsTextFormat(format) || format == 15 || IsImageFormat(format, name) ||
               IsClipboardPolicyFormat(format, name) ||
               format >= 0xc000 &&
                   (name == "HTML Format" || name == "Rich Text Format" ||
                    name == "Chromium internal source RFH token" || name == "Chromium internal source URL" ||
                    name == "Chromium Web Custom MIME Data Format");
    }
}
