import sys
import os

# Set OMP_NUM_THREADS to avoid high CPU usage
os.environ["OMP_NUM_THREADS"] = "4"

try:
    from docling.document_converter import DocumentConverter
except ImportError as e:
    print(f"Error importing docling: {e}. Make sure virtual environment is active/configured correctly.", file=sys.stderr, flush=True)
    sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print("Usage: python parse_document.py <file_path>", file=sys.stderr, flush=True)
        sys.exit(1)

    file_path = sys.argv[1]
    if not os.path.exists(file_path):
        print(f"Error: File '{file_path}' does not exist.", file=sys.stderr, flush=True)
        sys.exit(1)

    try:
        converter = DocumentConverter()
        result = converter.convert(file_path)
        markdown = result.document.export_to_markdown()
        print(markdown)
    except Exception as e:
        print(f"Conversion Error: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
