using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Text;

internal static class CardRenderer
{
    private static readonly Color[][] Palettes = new Color[][]
    {
        new [] { Color.FromArgb(22, 30, 33), Color.FromArgb(71, 91, 96), Color.FromArgb(239, 85, 71) },
        new [] { Color.FromArgb(244, 231, 219), Color.FromArgb(218, 136, 114), Color.FromArgb(60, 37, 31) },
        new [] { Color.FromArgb(23, 118, 110), Color.FromArgb(48, 173, 157), Color.FromArgb(255, 246, 223) },
        new [] { Color.FromArgb(48, 56, 112), Color.FromArgb(91, 99, 216), Color.FromArgb(241, 238, 255) }
    };

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length < 5) return 2;
        try
        {
            string output = args[0];
            string text = Encoding.UTF8.GetString(Convert.FromBase64String(args[1]));
            int index = Math.Max(1, int.Parse(args[2]));
            int count = Math.Max(index, int.Parse(args[3]));
            string account = Encoding.UTF8.GetString(Convert.FromBase64String(args[4]));
            Render(output, text, index, count, account);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.ToString());
            return 1;
        }
    }

    private static void Render(string output, string text, int index, int count, string account)
    {
        const int width = 1080;
        const int height = 1440;
        Color[] palette = Palettes[(index - 1) % Palettes.Length];
        bool light = GetBrightness(palette[0]) > 150;
        Color ink = light ? Color.FromArgb(45, 34, 30) : Color.White;
        Color muted = light ? Color.FromArgb(105, 83, 75) : Color.FromArgb(204, 218, 221);

        Directory.CreateDirectory(Path.GetDirectoryName(output));
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            using (var background = new LinearGradientBrush(new Rectangle(0, 0, width, height), palette[0], palette[1], 35f))
                graphics.FillRectangle(background, 0, 0, width, height);

            using (var glow = new SolidBrush(Color.FromArgb(light ? 38 : 50, palette[2])))
            {
                graphics.FillEllipse(glow, 690, -190, 650, 650);
                graphics.FillEllipse(glow, -260, 1050, 560, 560);
            }

            using (var line = new Pen(Color.FromArgb(light ? 45 : 42, ink), 2))
            {
                graphics.DrawLine(line, 92, 180, 988, 180);
                graphics.DrawLine(line, 92, 1260, 988, 1260);
            }

            using (var badgeBrush = new SolidBrush(palette[2]))
            using (var badgeText = new SolidBrush(light ? Color.White : palette[0]))
            using (var badgeFont = SafeFont(24, FontStyle.Bold))
            {
                FillRoundedRectangle(graphics, badgeBrush, new RectangleF(92, 82, 244, 58), 22);
                graphics.DrawString("CONTENTOPS", badgeFont, badgeText, new RectangleF(116, 96, 196, 34), new StringFormat { Alignment = StringAlignment.Center });
            }

            using (var pageFont = SafeFont(24, FontStyle.Bold))
            using (var pageBrush = new SolidBrush(muted))
                graphics.DrawString(index.ToString("00") + " / " + count.ToString("00"), pageFont, pageBrush, new RectangleF(810, 96, 178, 42), new StringFormat { Alignment = StringAlignment.Far });

            string[] paragraphs = text.Replace("\\n", "\n").Split(new[] { '\n' }, StringSplitOptions.None);
            string eyebrow = paragraphs.Length > 1 ? paragraphs[0] : "图文增长方法";
            string headline = paragraphs.Length > 1 ? string.Join("\n", paragraphs, 1, paragraphs.Length - 1) : paragraphs[0];
            if (String.IsNullOrWhiteSpace(headline)) headline = eyebrow;

            using (var eyebrowFont = SafeFont(28, FontStyle.Bold))
            using (var accentBrush = new SolidBrush(palette[2]))
                graphics.DrawString(eyebrow, eyebrowFont, accentBrush, new RectangleF(92, 310, 896, 56));

            using (var headlineFont = SafeFont(headline.Length > 34 ? 64 : 76, FontStyle.Bold))
            using (var headlineBrush = new SolidBrush(ink))
            using (var format = new StringFormat { Alignment = StringAlignment.Near, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisWord })
                graphics.DrawString(headline, headlineFont, headlineBrush, new RectangleF(92, 360, 896, 690), format);

            using (var footFont = SafeFont(25, FontStyle.Regular))
            using (var footBold = SafeFont(25, FontStyle.Bold))
            using (var footBrush = new SolidBrush(muted))
            {
                graphics.DrawString(String.IsNullOrWhiteSpace(account) ? "企业内容增长实验" : account, footBold, footBrush, new RectangleF(92, 1290, 500, 45));
                graphics.DrawString("由数据决定下一轮", footFont, footBrush, new RectangleF(590, 1290, 398, 45), new StringFormat { Alignment = StringAlignment.Far });
            }

            bitmap.Save(output, ImageFormat.Png);
        }
    }

    private static Font SafeFont(float size, FontStyle style)
    {
        try { return new Font("Microsoft YaHei UI", size, style, GraphicsUnit.Pixel); }
        catch { return new Font(FontFamily.GenericSansSerif, size, style, GraphicsUnit.Pixel); }
    }

    private static float GetBrightness(Color color) { return (color.R * 299 + color.G * 587 + color.B * 114) / 1000f; }

    private static void FillRoundedRectangle(Graphics graphics, Brush brush, RectangleF rect, float radius)
    {
        float diameter = radius * 2;
        using (var path = new GraphicsPath())
        {
            path.AddArc(rect.X, rect.Y, diameter, diameter, 180, 90);
            path.AddArc(rect.Right - diameter, rect.Y, diameter, diameter, 270, 90);
            path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rect.X, rect.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            graphics.FillPath(brush, path);
        }
    }
}
