"""Generate fake QR images for offline decoder regressions; never use real codes."""
import json
import sys
from pathlib import Path

import qrcode
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "anti_matter" / "app"))
from matter_setup_payload import ParsedSetupPayload, CommissioningFlow, generate_qr_payload

folder = Path(sys.argv[1])
folder.mkdir(parents=True, exist_ok=True)
payload = generate_qr_payload(ParsedSetupPayload(20202021, 15, 3840, 2,
    CommissioningFlow.STANDARD, 65521, 32768))
qr = qrcode.QRCode(box_size=10, border=0)
qr.add_data(payload)
qr.make(fit=True)
image = qr.make_image(fill_color=(45, 48, 52), back_color=(238, 240, 245)).convert("RGB")
image.save(folder / "tight-gray.png")
ImageOps.expand(image, border=40, fill="white").save(folder / "border-gray.png")
image.resize((1211, 1211)).save(folder / "tight-large.png")
ImageOps.invert(image).save(folder / "tight-inverted.png")
image.rotate(15, expand=True, fillcolor=(235, 239, 243)).save(folder / "rotated.png")
photo = Image.new("RGB", (1800, 1400), (162, 121, 81))
photo.paste(ImageOps.expand(image, border=40, fill="white"), (800, 540))
photo.save(folder / "photo.jpg")
Image.new("RGB", (500, 500), "white").save(folder / "blank.png")
(folder / "expected.json").write_text(json.dumps({"payload": payload}))
