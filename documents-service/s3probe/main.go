package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func main() {
	endpoint := os.Getenv("S3_ENDPOINT")
	ak := os.Getenv("S3_ACCESS_KEY")
	sk := os.Getenv("S3_SECRET_KEY")
	bucket := os.Getenv("S3_BUCKET")
	if endpoint == "" || ak == "" || sk == "" {
		fmt.Println("env missing")
		os.Exit(1)
	}

	cfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithBaseEndpoint(endpoint),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(ak, sk, "")),
		awsconfig.WithHTTPClient(&http.Client{Timeout: 10 * time.Second}),
	)
	if err != nil {
		fmt.Println("config err:", err)
		os.Exit(1)
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = true
		o.RetryMaxAttempts = 1
	})

	start := time.Now()
	_, err = client.PutObject(context.Background(), &s3.PutObjectInput{
		Bucket: &bucket,
		Key:    awsStr("tests/sdk-isolated-test.txt"),
		Body:   bytes.NewReader([]byte("sdk isolated test")),
	})
	if err != nil {
		fmt.Println("PUT ERROR:", err, "elapsed", time.Since(start))
		os.Exit(2)
	}
	fmt.Println("PUT OK elapsed", time.Since(start))

	// проверка: HEAD object
	out, err := client.HeadObject(context.Background(), &s3.HeadObjectInput{
		Bucket: &bucket,
		Key:    awsStr("tests/sdk-isolated-test.txt"),
	})
	if err != nil {
		fmt.Println("HEAD ERROR:", err)
		os.Exit(3)
	}
	fmt.Println("HEAD OK size", *out.ContentLength)
}

func awsStr(s string) *string { return &s }
