#!/bin/bash

# MSSQL to Oracle Migration - Quick Start Guide

echo "================================================"
echo "MSSQL to Oracle Database Converter"
echo "Quick Start Guide"
echo "================================================"
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ .env file not found!"
    echo "📝 Creating .env from .env.example..."
    cp .env.example .env
    echo "✅ .env file created"
    echo ""
    echo "⚠️  Please edit .env with your database credentials:"
    echo "   - MSSQL connection details"
    echo "   - Oracle connection details"
    echo "   - Migration preferences"
    echo ""
    exit 1
fi

echo "✅ Configuration found"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
npm install
echo "✅ Dependencies installed"
echo ""

# Build project
echo "🔨 Building project..."
npm run build
echo "✅ Build complete"
echo ""

echo "================================================"
echo "Migration Modes"
echo "================================================"
echo ""
echo "1️⃣  FULL MIGRATION (all tables)"
echo "   npm run migrate:full"
echo ""
echo "2️⃣  TEST MODE (single table for validation)"
echo "   npm run migrate:test --table=TABLE_NAME"
echo ""
echo "3️⃣  RESUME (from checkpoint)"
echo "   npm run migrate:resume"
echo ""

echo "================================================"
echo "Examples"
echo "================================================"
echo ""
echo "Test migration of 'users' table:"
echo "  MIGRATION_MODE=test TARGET_TABLE=users npm run dev"
echo ""
echo "Full migration with increased batch size:"
echo "  BATCH_SIZE=10000 npm run migrate:full"
echo ""
echo "Resume with debug logging:"
echo "  LOG_LEVEL=debug npm run migrate:resume"
echo ""

echo "================================================"
echo "Next Steps"
echo "================================================"
echo ""
echo "1. Edit .env with your database credentials"
echo "2. Test connection: npm run migrate:test --table=YourTable"
echo "3. If test passes, run full migration: npm run migrate:full"
echo "4. Monitor logs in ./logs/migration.log"
echo "5. Review errors in Oracle migration_errors table"
echo ""
echo "For more info, see README.md"
echo ""
