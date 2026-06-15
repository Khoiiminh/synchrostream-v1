import { S3Client, PutObjectCommand, GetObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassThrough, Readable } from 'stream';
import { Upload } from '@aws-sdk/lib-storage';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

@Injectable()
export class CloudflareR2Provider implements OnModuleInit {
    private s3!: S3Client;
    private bucketName!: string;

    constructor(private configService: ConfigService) {

    }

    onModuleInit() {
        const endpoint = this.configService.get<string>('R2_ENDPOINT');
        const accesskeyId = this.configService.get<string>('R2_ACCESS_KEY_ID');
        const secretAccessKey = this.configService.get<string>('R2_SECRET_ACCESS_KEY');
        const bucket = this.configService.get<string>('R2_BUCKET_NAME');

        if (!endpoint || !accesskeyId || !secretAccessKey || !bucket) {
            throw new Error('Missing Cloudflare R2 configuration in .env.development');
        }

        this.s3 = new S3Client({
            region: "auto",
            endpoint: endpoint,
            credentials: {
                accessKeyId: accesskeyId,
                secretAccessKey: secretAccessKey,
            },
            requestHandler: new NodeHttpHandler({
                connectionTimeout: 60000, // Max time allowed to establish initial TCP handshake (60s)
                socketTimeout: 300000,    // Max quiet time allowed during binary chunk stream transfers (5 mins)
                httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 150 }),
                httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 150 }),
            }),
        });

        this.bucketName = bucket;
        console.log('Cloudflare R2 Storage Provider initialized');
    }

    async startMultiPartUpload(key: string): Promise<string> {
        const command = new CreateMultipartUploadCommand({
            Bucket: this.bucketName,
            Key: key,
            ContentType: 'video/mp4',
        });

        const { UploadId } = await this.s3.send(command);
        return UploadId!;
    }

    async uploadPart({ key, uploadId, partNumber, body }: {
        key: string, 
        uploadId: string, 
        partNumber: number, 
        body: Buffer
    }): Promise<string> {
        const command = new UploadPartCommand({
            Bucket: this.bucketName,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: body,
        });

        const { ETag } = await this.s3.send(command);
        return ETag!;
    }

    async completeMultiPartUpload({ key, uploadId, parts }: {key: string, uploadId:string, parts: any[] }): Promise<void>{
        const command = new CompleteMultipartUploadCommand({
            Bucket: this.bucketName,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: parts.sort((a, b) => a.PartNumber - b.PartNumber),
            },
        });

        await this.s3.send(command);
    }

    /**
     * Retrieves an object from R2 as a Readable node stream to prevent local file-system leaks
     */
    async getObjectStream(key: string): Promise<Readable> {
        const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: key,
        });

        const response = await this.s3.send(command);

        if (!response) {
            throw new Error(`R2 Object Stream parsing error: Object body for key [${key}] is empty.`);
        }

        // Under NodeJS runtimes, S3 response.Body implements
        // the standard Readable stream interface
        return response.Body as Readable;
    }

    /**
     * Consumes a PassThrough or standard Readable stream and streams it out to R2 using @aws-sdk/lib-storage.
     * This ensures high-throughput multi-part stream handling without manual chunk partitioning loops.
     */
    async uploadStream({ key, stream, contentType }: {key:string, stream:Readable | PassThrough, contentType:string}): Promise<void> {
        try {
            const parallelUpload = new Upload({
                client: this.s3,
                params: {
                    Bucket: this.bucketName,
                    Key: key,
                    Body: stream,
                    ContentType: contentType,
                },
                queueSize: 4,   // 4 concurrent upload tasks
                partSize: 1024 * 1024 * 5,      // 5MB minimum chunk sizes enforced by s3 specifications
                leavePartsOnError: false,
            });

            await parallelUpload.done();
        } catch (error) {
            throw new Error(`Stream pipeline failure writing to target location [${key}]: ${(error as Error).message}`);
        }
    }

    async generatePresignedUrl(movieId: string): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: `film/${movieId}/master.m3u8`,
        });
        
        return getSignedUrl(this.s3, command, { expiresIn: 14400 });
    }

    async abortMultiPartUpload({ key, uploadId }: { key: string, uploadId: string }): Promise<void> {
        const command = new AbortMultipartUploadCommand({
            Bucket: this.bucketName,
            Key: key,
            UploadId: uploadId,
        });
        await this.s3.send(command);
    }
}
