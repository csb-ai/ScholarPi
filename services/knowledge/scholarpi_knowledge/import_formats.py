"""Convert supported local files into an explicitly labelled PDF reading edition."""
from pathlib import Path
from zipfile import ZipFile, BadZipFile
import xml.etree.ElementTree as ET
import unicodedata
import pymupdf
from .store import BusinessError

SUPPORTED = {'.pdf', '.txt', '.md', '.markdown', '.docx', '.png', '.jpg', '.jpeg'}

def conversion_note(suffix):
    if suffix == '.pdf':
        return None
    if suffix == '.docx':
        return 'DOCX 以正文文字导入，阅读页为重新排版；复杂图表、公式和原版式请先导出为 PDF。'
    if suffix in {'.png', '.jpg', '.jpeg'}:
        return '图片已生成 PDF 阅读版；文字识别按扫描材料处理，原图保留。'
    return '文本已生成 PDF 阅读版，页码与排版为系统生成，不是原文件页码。'

def file_text(path):
    if path.suffix.lower() == '.docx':
        try:
            with ZipFile(path) as package:
                info = package.getinfo('word/document.xml')
                if info.file_size > 20 * 1024 * 1024:
                    raise BusinessError('INVALID_ARGUMENT', 'DOCX 正文过大，请分卷或导出 PDF。')
                root = ET.fromstring(package.read(info))
                ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
                return '\n'.join(''.join((node.text or '') if node.tag == ns+'t' else '\t' if node.tag == ns+'tab' else '\n' if node.tag == ns+'br' else '' for node in paragraph.iter()) for paragraph in root.iter(ns+'p'))
        except (BadZipFile, KeyError, ET.ParseError) as exc:
            raise BusinessError('INVALID_ARGUMENT', '无法读取 DOCX 正文，请导出 PDF 后导入。') from exc
    raw = path.read_bytes()
    try:
        return raw.decode('utf-16') if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else raw.decode('utf-8-sig')
    except UnicodeError as exc:
        raise BusinessError('INVALID_ARGUMENT', '文本编码无法识别，请另存为 UTF-8 后导入。') from exc

def to_reading_pdf(path, target):
    suffix = path.suffix.lower()
    if suffix in {'.png', '.jpg', '.jpeg'}:
        try:
            with pymupdf.open(path) as image:
                target.write_bytes(image.convert_to_pdf())
            return
        except Exception as exc:
            raise BusinessError('INVALID_ARGUMENT', '无法读取图片，请使用有效的 PNG 或 JPG。') from exc
    text = file_text(path).replace('\x00', '')
    if not text.strip():
        raise BusinessError('INVALID_ARGUMENT', '文件没有可读取正文；扫描或复杂文档请导出 PDF。')
    # Generated pages are a reading representation, not a reconstruction of Word layout.
    with pymupdf.open() as doc:
        page = doc.new_page(width=595, height=842)
        y = 46
        def emit(line):
            nonlocal page, y
            if y > 800:
                if len(doc) >= 300:
                    raise BusinessError('INVALID_ARGUMENT', '生成阅读版超过 300 页，请分卷导入。')
                page = doc.new_page(width=595, height=842)
                y = 46
            if line:
                page.insert_text((42, y), line, fontname='china-s', fontsize=10)
            y += 16
        for paragraph in text.expandtabs(4).split('\n'):
            line, width = '', 0.0
            for char in paragraph.rstrip('\r'):
                unit = 1.0 if unicodedata.east_asian_width(char) in {'W', 'F'} else 0.6
                if width + unit > 48:
                    emit(line); line, width = '', 0.0
                line += char; width += unit
            emit(line)
        doc.save(target)
