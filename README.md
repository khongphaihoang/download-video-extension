# Video Grabber 🎬

**Video Grabber** là tiện ích mở rộng (Chrome Extension Manifest V3) mạnh mẽ dành cho các trình duyệt Chromium (Google Chrome, Microsoft Edge, Cốc Cốc, Brave), giúp tự động phát hiện, bắt luồng và tải video từ hầu hết các trang web — đặc biệt hỗ trợ chuyên sâu cho **YouTube**, **Facebook (kể cả Group kín)**, **TikTok** và **Instagram**.

---

## ✨ Tính năng nổi bật

- ⚡ **Bắt luồng theo thời gian thực:** Hook trực tiếp các luồng phát MSE (Media Source Extensions), DASH, HLS và thẻ video HTML5 ngay khi video bắt đầu chạy.
- ▶️ **YouTube (Đầy đủ mọi độ phân giải):**
  - **Tải nhanh (360p / 480p Shorts):** Tải trực tiếp qua trình duyệt với đầy đủ âm thanh và hình ảnh, không cần cài đặt thêm phần mềm nào.
  - **Tải chất lượng cao HQ (480p, 720p, 1080p, 2K, 4K):** Tích hợp Native Host tự động điều khiển `yt-dlp` và `ffmpeg` tải và ghép luồng hình + tiếng thành file MP4 hoàn chỉnh.
- 🔵 **Facebook (Hỗ trợ Group Private / Nhóm kín):**
  - Tải Reels, Watch, bài viết cá nhân và video trong nhóm kín.
  - Tận dụng chính phiên đăng nhập (session) của bạn trên trình duyệt, không yêu cầu cấp quyền hay nhập tài khoản/mật khẩu.
- 🎵 **TikTok:** Cơ chế tải thông minh vượt qua các hạn chế chống tải trực tiếp và lỗi 403 Forbidden của CDN Akamai.
- 📸 **Instagram:** Bắt nhanh Reels, Post video và Story.
- 👁️ **Xem thử trực tiếp (Preview):** Phát video xem trước ngay trong Popup trước khi quyết định tải về.
- 🛠️ **Bộ công cụ chẩn đoán & Debug tích hợp:**
  - Nút **[🔄 Reload Ext & Tab]** 1-click giúp nạp lại mã nguồn mới mà không cần vào `chrome://extensions`.
  - Đèn trạng thái kết nối và Live Logs ghi nhận 25 sự kiện mạng gần nhất.
  - 1-click sao chép báo cáo chẩn đoán (Diagnostic Report) để kiểm tra lỗi.

---

## 🚀 Hướng dẫn cài đặt

### 1. Cài đặt Extension vào trình duyệt

1. Tải hoặc clone mã nguồn extension về máy tính.
2. Mở trang quản lý tiện ích trên trình duyệt:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Cốc Cốc: `coccoc://extensions`
3. Bật công tắc **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
4. Bấm **Load unpacked** (Tải tiện ích đã giải nén) → chọn thư mục mã nguồn extension này.
5. Ghim icon **Video Grabber** lên thanh công cụ trình duyệt để tiện sử dụng.
6. **Lưu ý:** Ghi nhớ hoặc copy chuỗi **ID** của extension (ví dụ: `dhmmcdjieldakilcgkojlcgmobeiddfg`) hiển thị trên thẻ extension.

---

### 2. Cài đặt Native Host (Tùy chọn — Dùng để tải YouTube 1080p, 2K, 4K)

> [!NOTE]
> Nếu bạn chỉ cần tải video Facebook, TikTok, Instagram và YouTube ở độ phân giải 360p, bạn **không cần** thực hiện bước này.
> Nếu muốn tải YouTube ở độ phân giải cao (**720p, 1080p, 2K, 4K**), hãy chạy lệnh bên dưới một lần duy nhất.

1. Mở cửa sổ **PowerShell** tại thư mục `native-host` của dự án:
   ```powershell
   cd native-host
   .\install.ps1 -ExtensionId <ID_EXTENSION_CỦA_BẠN> -InstallDeps
   ```
   *Ví dụ:*
   ```powershell
   .\install.ps1 -ExtensionId dhmmcdjieldakilcgkojlcgmobeiddfg -InstallDeps
   ```
   *(Tham số `-InstallDeps` sẽ tự động tải và cài đặt `yt-dlp` và `ffmpeg` qua Windows Package Manager `winget` nếu máy chưa có).*
2. Vào `chrome://extensions` bấm nút **🔄 Reload** lại extension.

---

## 📖 Hướng dẫn sử dụng

### 1. YouTube

1. Mở video hoặc Shorts trên YouTube.
2. Bấm icon extension trên thanh công cụ.
3. **Lựa chọn cách tải:**
   - **Tải nhanh (360p / 480p Shorts):** Bấm nút **⬇️ Tải** màu xanh để tải ngay qua trình duyệt (đầy đủ âm thanh & hình ảnh).
   - **Tải chất lượng cao (480p – 4K):** Chọn độ phân giải mong muốn tại hàng **Tải HQ:** (ví dụ: `1080p`, `4K`) rồi bấm nút **⬇️ Tải (yt-dlp)**. File hoàn chỉnh sẽ tự động được lưu vào thư mục `Downloads`.

### 2. Facebook (Video công khai & Group kín)

1. Mở bài viết có video hoặc mở nhóm kín Facebook.
2. Bấm **Play** để video phát (extension cần video phát để nhận diện luồng).
3. Mở popup extension:
   - Nếu video chưa xuất hiện ngay, bấm nút **Quét sâu** để extension phân tích mã nguồn HTML và JSON nhúng.
   - Chọn chất lượng HD/SD tương ứng rồi bấm **⬇️ Tải**.

### 3. TikTok & Instagram

1. Mở video TikTok hoặc Reel Instagram.
2. Bấm vào icon extension → danh sách link tải sẽ hiển thị.
3. Bấm **👁️ Xem thử** để xem video trước, hoặc bấm **⬇️ Tải** để lưu về máy.

### 4. Các trang web xem phim, tin tức khác

1. Bật phát video trên trang web.
2. Mở popup extension → chọn file video `.mp4` hoặc luồng stream tương ứng trong danh sách để tải.

---

## 🏗️ Kiến trúc & Nguyên lý hoạt động

```mermaid
flowchart TD
    subgraph Browser Context
        A["inject.js (MAIN World)<br/>Hook fetch, XHR, video.src, YouTube Innertube"] -->|"window.postMessage"| B["content.js (Isolated World)<br/>Lọc URL, quét DOM, phân tích JSON"]
        P["PerformanceObserver<br/>Giám sát mạng buffer lớn"] --> B
        B -->|"chrome.runtime.sendMessage"| C["background.js (Service Worker)<br/>Lưu trữ theo Tab, quản lý tải"]
        D["rules/referer.json<br/>DNR: Tự gắn Referer & User-Agent"] -.-> C
    end

    subgraph User Interface
        E["popup.js / popup.html<br/>Giao diện hiển thị, chọn chất lượng, Preview"] <--> C
    end

    subgraph Native Host (Tùy chọn)
        C -->|"Native Messaging<br/>(stdio)"| F["vg_host.py (Python Host)<br/>Điều khiển yt-dlp + ffmpeg"]
        F --> G["Tải & Ghép luồng 1080p/4K<br/>Lưu trực tiếp vào Downloads"]
    end
```

### Cấu trúc mã nguồn

```
download-video-extension/
├── manifest.json              # Khai báo quyền Manifest V3, Service Worker, Content Scripts
├── rules/
│   └── referer.json           # DNR Rules: Tự động gắn Referer/Origin cho fbcdn, googlevideo, tiktok
├── native-host/               # Module Native Messaging hỗ trợ tải YouTube HQ
│   ├── install.ps1            # Script tự động đăng ký host vào Registry & cài đặt dependencies
│   ├── vg_host.py             # Python Host giao tiếp với extension qua stdin/stdout
│   └── vg_host.bat            # File batch trung gian khởi chạy Python trên Windows
└── src/
    ├── background.js          # Service Worker điều phối tải file, lưu session và gọi Native Host
    ├── content.js             # Content Script gom nguồn, phân tích DOM và gửi dữ liệu lên background
    ├── inject.js              # MAIN World Script hook network, bắt luồng MSE/DASH
    ├── popup.html             # Giao diện Popup extension
    ├── popup.css              # Giao diện Dark-mode, thiết kế responsive
    ├── popup.js               # Logic điều khiển giao diện Popup, Preview, chất lượng
    └── social/                # Các module xử lý chuyên biệt theo từng nền tảng
        ├── fb/                # Xử lý Facebook (Parser JSON, Group private, Reels)
        ├── ig/                # Xử lý Instagram (Post, Reels, Story)
        ├── tiktok/            # Xử lý TikTok (Bypass CORS, tải qua Tab blob)
        └── ytb/               # Xử lý YouTube (Innertube Android API, bộ lọc SABR, HQ)
```

---

## ❓ Xử lý sự cố thường gặp (Troubleshooting)

| Hiện tượng | Nguyên nhân | Cách khắc phục |
| :--- | :--- | :--- |
| **Báo lỗi `Chưa cài native host` khi tải HQ** | Chưa đăng ký script vào Registry hoặc ID extension bị thay đổi. | Chạy lại lệnh `.\install.ps1 -ExtensionId <ID_CỦA_BẠN>` trong thư mục `native-host`. |
| **YouTube chỉ thấy chất lượng 360p** | YouTube phân phối các bản 720p, 1080p, 4K dưới dạng luồng hình câm tách biệt (DASH). | Sử dụng nút **Tải HQ (yt-dlp)** ở ngay bên dưới để tải bản 1080p hoặc 4K có tiếng. |
| **Video Facebook trong nhóm kín tải bị 403** | Token hoặc link của CDN Facebook đã hết hạn sau 1–2 giờ. | Mở lại bài viết trên Facebook, bấm nút **Quét sâu** trong popup để lấy link mới. |
| **Popup hiển thị `Chưa bắt được video nào`** | Video chưa được phát hoặc content script chưa nạp kịp. | Bấm **Play** video, sau đó bấm mở mục **🛠️ Chẩn đoán & Debug** → chọn **[🔄 Reload Ext & Tab]**. |
| **TikTok báo lỗi tải về máy** | Trình duyệt chặn tải trực tiếp từ CDN Akamai do CORS. | Extension sẽ tự động chuyển sang tải ngầm qua blob trong tab, hãy đợi vài giây để file được lưu. |

---

## 📄 Bản quyền & Giấy phép

Dự án được phát triển nhằm mục đích học tập, nghiên cứu kỹ thuật và sao lưu dữ liệu cá nhân hợp pháp. Vui lòng tôn trọng quyền sở hữu trí tuệ và điều khoản dịch vụ của các nền tảng nội dung.
